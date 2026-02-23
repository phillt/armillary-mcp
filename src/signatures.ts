import {
  type ExportedDeclarations,
  Node,
  FunctionDeclaration,
  ClassDeclaration,
  VariableDeclaration,
} from "ts-morph";

export function getSignature(
  declaration: ExportedDeclarations
): string | undefined {
  if (Node.isFunctionDeclaration(declaration)) {
    return getFunctionSignature(declaration);
  }

  if (Node.isClassDeclaration(declaration)) {
    return getClassSignature(declaration);
  }

  if (
    Node.isInterfaceDeclaration(declaration) ||
    Node.isTypeAliasDeclaration(declaration) ||
    Node.isEnumDeclaration(declaration)
  ) {
    return declaration.getText();
  }

  if (Node.isVariableDeclaration(declaration)) {
    return getVariableSignature(declaration);
  }

  return undefined;
}

function getFunctionSignature(decl: FunctionDeclaration): string {
  const body = decl.getBody();
  if (body) {
    const fullText = decl.getText();
    const bodyStart = body.getStart() - decl.getStart();
    return fullText.substring(0, bodyStart).trimEnd();
  }
  // No body (overload signature or ambient declaration)
  return decl.getText();
}

function getClassSignature(decl: ClassDeclaration): string {
  let sig = "class";
  const name = decl.getName();
  if (name) sig += ` ${name}`;

  const typeParams = decl.getTypeParameters();
  if (typeParams.length > 0) {
    sig += `<${typeParams.map((tp) => tp.getText()).join(", ")}>`;
  }

  const baseClass = decl.getExtends();
  if (baseClass) {
    sig += ` extends ${baseClass.getText()}`;
  }

  const implementations = decl.getImplements();
  if (implementations.length > 0) {
    sig += ` implements ${implementations.map((i) => i.getText()).join(", ")}`;
  }

  return sig;
}

function getVariableSignature(decl: VariableDeclaration): string {
  const name = decl.getName();
  const initializer = decl.getInitializer();

  // Arrow function or function expression
  if (
    initializer &&
    (Node.isArrowFunction(initializer) ||
      Node.isFunctionExpression(initializer))
  ) {
    const params = initializer.getParameters();
    const paramText = params.map((p) => p.getText()).join(", ");

    const returnType = initializer.getReturnTypeNode();
    const typeParams = initializer.getTypeParameters();
    const typeParamText =
      typeParams.length > 0
        ? `<${typeParams.map((tp) => tp.getText()).join(", ")}>`
        : "";

    let sig = `const ${name} = ${typeParamText}(${paramText})`;
    if (returnType) {
      sig += `: ${returnType.getText()}`;
    }
    sig += " => ...";
    return sig;
  }

  // Regular const with type annotation
  const typeNode = decl.getTypeNode();
  if (typeNode) {
    return `const ${name}: ${typeNode.getText()}`;
  }

  // Fall back to inferred type
  try {
    const typeText = decl.getType().getText(decl);
    // If type resolution produced an import-path string, it's not useful
    if (typeText && !typeText.startsWith("import(")) {
      return `const ${name}: ${typeText}`;
    }
  } catch {
    // Type resolution can fail without the full type graph
  }
  return `const ${name}`;
}
