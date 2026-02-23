import {
  type SourceFile,
  type ExportedDeclarations,
  Node,
  VariableDeclaration,
} from "ts-morph";
import path from "node:path";
import type { SymbolDoc } from "./schema.js";
import { extractJsDoc, type ExtractedParam } from "./jsdoc.js";
import { getSignature } from "./signatures.js";

type SymbolKind = SymbolDoc["kind"];

function resolveKind(
  declaration: ExportedDeclarations
): SymbolKind | undefined {
  if (Node.isFunctionDeclaration(declaration)) return "function";
  if (Node.isClassDeclaration(declaration)) return "class";
  if (Node.isInterfaceDeclaration(declaration)) return "interface";
  if (Node.isTypeAliasDeclaration(declaration)) return "type";
  if (Node.isEnumDeclaration(declaration)) return "enum";

  if (Node.isVariableDeclaration(declaration)) {
    const initializer = (declaration as VariableDeclaration).getInitializer();
    if (
      initializer &&
      (Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer))
    ) {
      return "function";
    }
    return "const";
  }

  // Skip unsupported kinds: ModuleDeclaration, Expression, SourceFile
  return undefined;
}

function getAstParams(
  declaration: ExportedDeclarations
): { name: string; type?: string }[] {
  let params: { name: string; type?: string }[] = [];

  if (Node.isFunctionDeclaration(declaration)) {
    params = declaration.getParameters().map((p) => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText(),
    }));
  } else if (Node.isVariableDeclaration(declaration)) {
    const init = (declaration as VariableDeclaration).getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      params = init.getParameters().map((p) => ({
        name: p.getName(),
        type: p.getTypeNode()?.getText(),
      }));
    }
  }

  return params;
}

function mergeParams(
  astParams: { name: string; type?: string }[],
  jsDocParams?: ExtractedParam[]
): ExtractedParam[] | undefined {
  if (astParams.length === 0 && (!jsDocParams || jsDocParams.length === 0)) {
    return undefined;
  }

  const jsDocMap = new Map<string, ExtractedParam>();
  if (jsDocParams) {
    for (const p of jsDocParams) {
      jsDocMap.set(p.name, p);
    }
  }

  if (astParams.length > 0) {
    return astParams.map((ast) => {
      const jsDoc = jsDocMap.get(ast.name);
      const merged: ExtractedParam = { name: ast.name };
      // AST type takes priority
      if (ast.type) {
        merged.type = ast.type;
      } else if (jsDoc?.type) {
        merged.type = jsDoc.type;
      }
      if (jsDoc?.description) {
        merged.description = jsDoc.description;
      }
      return merged;
    });
  }

  // Only JSDoc params, no AST params
  return jsDocParams;
}

function toRelativePosixPath(filePath: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, filePath);
  if (path.sep === "/") return rel;
  return rel.replaceAll(path.sep, "/");
}

export function extractFileSymbols(
  sourceFile: SourceFile,
  projectRoot: string,
  precomputedDeclarations?: ReadonlyMap<string, ExportedDeclarations[]>
): SymbolDoc[] {
  const symbols: SymbolDoc[] = [];
  const sourceFilePath = sourceFile.getFilePath();
  const relativePath = toRelativePosixPath(sourceFilePath, projectRoot);

  const exportedDecls = precomputedDeclarations ?? sourceFile.getExportedDeclarations();

  for (const [exportName, declarations] of exportedDecls.entries()) {
    for (const declaration of declarations) {
      // Skip re-exports: only process declarations from this file
      const declSourceFile = declaration.getSourceFile();
      if (declSourceFile.getFilePath() !== sourceFilePath) {
        continue;
      }

      const kind = resolveKind(declaration);
      if (!kind) continue;

      const id = `${relativePath}#${exportName}`;
      const signature = getSignature(declaration);
      const jsDoc = extractJsDoc(declaration);

      const astParams = getAstParams(declaration);
      const params = mergeParams(astParams, jsDoc?.params);

      const symbolDoc: SymbolDoc = {
        id,
        kind,
        name: exportName,
        filePath: relativePath,
        exported: true,
      };

      if (signature) symbolDoc.signature = signature;
      if (jsDoc?.description) symbolDoc.description = jsDoc.description;
      if (params) symbolDoc.params = params;
      if (jsDoc?.returns) symbolDoc.returns = jsDoc.returns;
      if (jsDoc?.tags) symbolDoc.tags = jsDoc.tags;

      symbols.push(symbolDoc);
    }
  }

  return symbols;
}
