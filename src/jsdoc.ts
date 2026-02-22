import { Node, JSDoc, type JSDocTag, VariableDeclaration } from "ts-morph";

export interface ExtractedParam {
  name: string;
  type?: string;
  description?: string;
}

export interface ExtractedJsDoc {
  description?: string;
  params?: ExtractedParam[];
  returns?: { type?: string; description?: string };
  tags?: Record<string, string>;
}

function getJsDocs(node: Node): JSDoc[] {
  if (Node.isJSDocable(node)) {
    return node.getJsDocs();
  }
  if (Node.isVariableDeclaration(node)) {
    const statement = (node as VariableDeclaration).getVariableStatement();
    if (statement) {
      return statement.getJsDocs();
    }
  }
  return [];
}

export function extractJsDoc(node: Node): ExtractedJsDoc | undefined {
  const docs = getJsDocs(node);
  if (docs.length === 0) return undefined;

  const lastDoc = docs[docs.length - 1];
  const result: ExtractedJsDoc = {};

  const description = lastDoc.getDescription().trim();
  if (description) {
    result.description = description;
  }

  const allTags = lastDoc.getTags();
  const params: ExtractedParam[] = [];
  let returns: { type?: string; description?: string } | undefined;
  const tagsRecord: Record<string, string> = {};

  for (const tag of allTags) {
    const tagName = tag.getTagName();

    if (tagName === "param") {
      const param = extractParamTag(tag);
      if (param) params.push(param);
    } else if (tagName === "returns" || tagName === "return") {
      returns = extractReturnsTag(tag);
    } else {
      const value = getTagText(tag).trim();
      if (tagName in tagsRecord) {
        tagsRecord[tagName] += "\n" + value;
      } else {
        tagsRecord[tagName] = value;
      }
    }
  }

  if (params.length > 0) result.params = params;
  if (returns) result.returns = returns;

  if (Object.keys(tagsRecord).length > 0) {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(tagsRecord).sort()) {
      sorted[key] = tagsRecord[key];
    }
    result.tags = sorted;
  }

  if (Object.keys(result).length === 0) return undefined;
  return result;
}

function extractParamTag(tag: JSDocTag): ExtractedParam | undefined {
  // ts-morph JSDocParameterTag has structured accessors
  const paramTag = tag as unknown as {
    getName?: () => string;
    getTypeExpression?: () => { getText: () => string } | undefined;
  };

  if (typeof paramTag.getName === "function") {
    const name = paramTag.getName();
    const param: ExtractedParam = { name };

    const typeExpr = paramTag.getTypeExpression?.();
    if (typeExpr) {
      // getText() returns "{type}", strip the braces
      const typeText = typeExpr.getText().replace(/^\{|\}$/g, "");
      if (typeText) param.type = typeText;
    }

    const comment = getTagText(tag).trim();
    // Strip leading "- " from description
    const desc = comment.replace(/^-\s*/, "").trim();
    if (desc) param.description = desc;

    return param;
  }

  // Fallback: parse from raw text
  const text = getTagText(tag);
  const match = text.match(
    /^(?:\{([^}]*)\}\s+)?(\[?[\w.]+\]?)\s*(?:-\s*)?(.*)?$/s
  );
  if (!match) return undefined;

  const param: ExtractedParam = { name: match[2].replace(/[\[\]]/g, "") };
  if (match[1]) param.type = match[1];
  if (match[3]?.trim()) param.description = match[3].trim();
  return param;
}

function extractReturnsTag(
  tag: JSDocTag
): { type?: string; description?: string } | undefined {
  const returnTag = tag as unknown as {
    getTypeExpression?: () => { getText: () => string } | undefined;
  };

  const result: { type?: string; description?: string } = {};

  const typeExpr = returnTag.getTypeExpression?.();
  if (typeExpr) {
    const typeText = typeExpr.getText().replace(/^\{|\}$/g, "");
    if (typeText) result.type = typeText;
  }

  const comment = getTagText(tag).trim();
  if (comment) result.description = comment;

  return Object.keys(result).length > 0 ? result : {};
}

function getTagText(tag: JSDocTag): string {
  return tag.getCommentText() ?? "";
}
