import { Project, Node, SyntaxKind, type SourceFile, type Type } from "ts-morph";
import path from "node:path";
import type { ArmillaryPlugin, PluginContext } from "../plugins.js";
import type { SymbolDoc } from "../schema.js";
import { extractFileSymbols } from "../extractor.js";

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

/**
 * Check if a function/arrow body contains JSX nodes.
 */
function bodyContainsJsx(node: Node): boolean {
  // Look for JsxElement, JsxSelfClosingElement, or JsxFragment in descendants
  return node.getDescendants().some(
    (d) =>
      Node.isJsxElement(d) ||
      Node.isJsxSelfClosingElement(d) ||
      Node.isJsxFragment(d)
  );
}

/**
 * Check if a return type string suggests a React component.
 */
function isReactReturnType(typeText: string): boolean {
  return /^(JSX\.Element|React\.ReactElement|ReactElement|React\.ReactNode|ReactNode)/.test(
    typeText
  );
}

/**
 * Detect whether a symbol is a React component.
 */
function isReactComponent(
  sym: SymbolDoc,
  sourceFile: SourceFile
): boolean {
  if (!isPascalCase(sym.name)) return false;
  if (sym.kind !== "function" && sym.kind !== "const") return false;

  const exportedDecls = sourceFile.getExportedDeclarations();
  // Try the original export name; for default exports we need to check "default"
  let declarations = exportedDecls.get(sym.name);
  if (!declarations || declarations.length === 0) {
    declarations = exportedDecls.get("default");
  }
  if (!declarations || declarations.length === 0) return false;

  for (const decl of declarations) {
    // Function declaration
    if (Node.isFunctionDeclaration(decl)) {
      const body = decl.getBody();
      if (body && bodyContainsJsx(body)) return true;
      const returnType = decl.getReturnType().getText(decl);
      if (isReactReturnType(returnType)) return true;
    }

    // Variable declaration (arrow function, FC, HOC)
    if (Node.isVariableDeclaration(decl)) {
      // Check type annotation for React.FC / FunctionComponent
      const typeNode = decl.getTypeNode();
      if (typeNode) {
        const typeText = typeNode.getText();
        if (/^(React\.)?(FC|FunctionComponent)\b/.test(typeText)) {
          return true;
        }
      }

      const initializer = decl.getInitializer();
      if (!initializer) continue;

      // HOC wrapper: forwardRef(...), memo(...), React.forwardRef(...), React.memo(...)
      if (Node.isCallExpression(initializer)) {
        const exprText = initializer.getExpression().getText();
        if (
          /^(React\.)?(forwardRef|memo)$/.test(exprText)
        ) {
          return true;
        }
      }

      // Arrow function / function expression with JSX
      if (
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)
      ) {
        const body = initializer.getBody();
        if (body && bodyContainsJsx(body)) return true;
        const returnType = initializer.getReturnType().getText(decl);
        if (isReactReturnType(returnType)) return true;
      }
    }
  }

  return false;
}

/**
 * Extract props from a component's type information.
 */
function extractProps(
  sym: SymbolDoc,
  sourceFile: SourceFile
): SymbolDoc["params"] | undefined {
  const exportedDecls = sourceFile.getExportedDeclarations();
  let declarations = exportedDecls.get(sym.name);
  if (!declarations || declarations.length === 0) {
    declarations = exportedDecls.get("default");
  }
  if (!declarations || declarations.length === 0) return undefined;

  for (const decl of declarations) {
    let propsType: Type | undefined;

    if (Node.isFunctionDeclaration(decl)) {
      const params = decl.getParameters();
      if (params.length > 0) {
        propsType = params[0].getType();
      }
    }

    if (Node.isVariableDeclaration(decl)) {
      const typeNode = decl.getTypeNode();
      if (typeNode) {
        const typeText = typeNode.getText();
        // React.FC<Props> or FC<Props> — extract the type argument
        if (/^(React\.)?(FC|FunctionComponent)</.test(typeText)) {
          const typeRef = typeNode.asKind(SyntaxKind.TypeReference);
          if (typeRef) {
            const typeArgs = typeRef.getTypeArguments();
            if (typeArgs.length > 0) {
              propsType = typeArgs[0].getType();
            }
          }
        }
      }

      const initializer = decl.getInitializer();
      if (initializer) {
        // forwardRef<Ref, Props>(...) — props is second type arg
        if (Node.isCallExpression(initializer)) {
          const exprText = initializer.getExpression().getText();
          if (/^(React\.)?forwardRef$/.test(exprText)) {
            const typeArgs = initializer.getTypeArguments();
            if (typeArgs.length >= 2) {
              propsType = typeArgs[1].getType();
            } else {
              // Try to infer from the callback argument
              const args = initializer.getArguments();
              if (args.length > 0 && (Node.isArrowFunction(args[0]) || Node.isFunctionExpression(args[0]))) {
                const callbackParams = args[0].getParameters();
                if (callbackParams.length > 0) {
                  propsType = callbackParams[0].getType();
                }
              }
            }
          } else if (/^(React\.)?memo$/.test(exprText)) {
            // memo(Component) or memo((...) => JSX) — get from inner function params
            const args = initializer.getArguments();
            if (args.length > 0) {
              const arg = args[0];
              if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
                const callbackParams = arg.getParameters();
                if (callbackParams.length > 0) {
                  propsType = callbackParams[0].getType();
                }
              }
            }
          }
        }

        // Arrow function / function expression
        if (
          !propsType &&
          (Node.isArrowFunction(initializer) ||
            Node.isFunctionExpression(initializer))
        ) {
          const params = initializer.getParameters();
          if (params.length > 0) {
            propsType = params[0].getType();
          }
        }
      }
    }

    if (propsType) {
      return expandPropsType(propsType, decl);
    }
  }

  return undefined;
}

/**
 * Expand a props type into individual param entries.
 * Only expand direct members; skips any properties declared in node_modules.
 */
function expandPropsType(
  propsType: Type,
  contextNode: Node
): SymbolDoc["params"] | undefined {
  const properties = propsType.getProperties();
  if (properties.length === 0) return undefined;

  // Filter to only properties declared in the project (skip inherited HTML/DOM attributes)
  const params: NonNullable<SymbolDoc["params"]> = [];

  for (const prop of properties) {
    const declarations = prop.getDeclarations();
    // Skip properties with no declarations in user code (e.g., inherited from React types)
    if (declarations.length === 0) continue;
    const declFile = declarations[0].getSourceFile().getFilePath();
    if (declFile.includes("node_modules")) continue;

    const name = prop.getName();
    const valueDecl = prop.getValueDeclaration();
    const type = valueDecl
      ? valueDecl.getType().getText(contextNode)
      : prop.getDeclaredType().getText(contextNode);

    const entry: { name: string; type?: string; description?: string } = {
      name,
    };
    if (type && type !== "any") {
      entry.type = type;
    }

    // Extract JSDoc description from the property declaration
    const decl0 = declarations[0];
    if (Node.isPropertySignature(decl0) || Node.isPropertyDeclaration(decl0)) {
      const docs = decl0.getJsDocs();
      if (docs.length > 0) {
        const desc = docs[docs.length - 1].getDescription().trim();
        if (desc) entry.description = desc;
      }
    }

    params.push(entry);
  }

  if (params.length === 0) return undefined;

  // Sort alphabetically
  params.sort((a, b) => a.name.localeCompare(b.name));
  return params;
}

/**
 * Resolve the actual name of a default export.
 */
function resolveDefaultExportName(sourceFile: SourceFile): string | undefined {
  const defaultDecls = sourceFile.getExportedDeclarations().get("default");
  if (!defaultDecls || defaultDecls.length === 0) return undefined;

  const decl = defaultDecls[0];
  if (Node.isFunctionDeclaration(decl)) {
    const name = decl.getName();
    if (name && isPascalCase(name)) return name;
  }
  if (Node.isVariableDeclaration(decl)) {
    const name = decl.getName();
    if (name && isPascalCase(name)) return name;
  }

  return undefined;
}

/**
 * React plugin — scoped via IIFE to avoid module-level mutable state.
 */
const reactPlugin: ArmillaryPlugin = (() => {
  let project: Project | undefined;
  let projectRoot: string | undefined;

  return {
    name: "react",
    extensions: [".tsx", ".jsx"],

    async init(context: PluginContext) {
      projectRoot = context.projectRoot;
      project = new Project({
        tsConfigFilePath: context.tsConfigFilePath,
        skipAddingFilesFromTsConfig: false,
      });
    },

    async dispose() {
      project = undefined;
      projectRoot = undefined;
    },

    extractSymbols(filePath: string, content: string): SymbolDoc[] {
      if (!project) {
        throw new Error("React plugin not initialized");
      }

      // Add or update the source file in the project
      let sourceFile = project.getSourceFile(filePath);
      if (sourceFile) {
        sourceFile.replaceWithText(content);
      } else {
        sourceFile = project.createSourceFile(filePath, content, {
          overwrite: true,
        });
      }

      // Reuse the core extractor
      const symbols = extractFileSymbols(sourceFile, projectRoot!);

      // Post-process: detect components and enrich metadata
      for (const sym of symbols) {
        // Resolve default export names
        if (sym.name === "default") {
          const resolvedName = resolveDefaultExportName(sourceFile);
          if (resolvedName) {
            sym.name = resolvedName;
            sym.id = `${sym.filePath}#${resolvedName}`;
          }
        }

        // Detect and upgrade React components
        if (isReactComponent(sym, sourceFile)) {
          sym.kind = "component";

          // Extract props
          const props = extractProps(sym, sourceFile);
          if (props) {
            sym.params = props;
          }
        }
      }

      return symbols;
    },
  };
})();

export default reactPlugin;
