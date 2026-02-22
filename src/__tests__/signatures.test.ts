import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { getSignature } from "../signatures.js";

function createProject() {
  return new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
}

describe("getSignature", () => {
  it("returns function signature without body", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export function add(a: number, b: number): number {
  return a + b;
}`
    );
    const fn = sf.getFunctionOrThrow("add");
    const sig = getSignature(fn);
    expect(sig).toBe("export function add(a: number, b: number): number");
  });

  it("returns full text for interface declarations", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export interface Options {
  name: string;
  value: number;
}`
    );
    const iface = sf.getInterfaceOrThrow("Options");
    const sig = getSignature(iface);
    expect(sig).toContain("interface Options");
    expect(sig).toContain("name: string");
    expect(sig).toContain("value: number");
  });

  it("returns full text for type alias declarations", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export type ID = string | number;`
    );
    const typeAlias = sf.getTypeAliasOrThrow("ID");
    const sig = getSignature(typeAlias);
    expect(sig).toBe("export type ID = string | number;");
  });

  it("returns full text for enum declarations", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export enum Color {
  Red,
  Green,
  Blue,
}`
    );
    const enumDecl = sf.getEnumOrThrow("Color");
    const sig = getSignature(enumDecl);
    expect(sig).toContain("enum Color");
    expect(sig).toContain("Red");
  });

  it("returns class signature with extends and implements", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
interface Serializable { serialize(): string; }
class Base {}
export class Foo<T> extends Base implements Serializable {
  serialize(): string { return ""; }
}`
    );
    const cls = sf.getClassOrThrow("Foo");
    const sig = getSignature(cls);
    expect(sig).toBe("class Foo<T> extends Base implements Serializable");
  });

  it("returns class signature without extends/implements", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export class Simple {
  value = 1;
}`
    );
    const cls = sf.getClassOrThrow("Simple");
    const sig = getSignature(cls);
    expect(sig).toBe("class Simple");
  });

  it("handles arrow function variable declarations", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export const greet = (name: string): string => \`Hello \${name}\`;`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("greet");
    const sig = getSignature(varDecl);
    expect(sig).toBe("const greet = (name: string): string => ...");
  });

  it("handles arrow function without return type annotation", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export const double = (n: number) => n * 2;`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("double");
    const sig = getSignature(varDecl);
    expect(sig).toBe("const double = (n: number) => ...");
  });

  it("handles const with type annotation", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export const MAX_SIZE: number = 100;`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("MAX_SIZE");
    const sig = getSignature(varDecl);
    expect(sig).toBe("const MAX_SIZE: number");
  });

  it("handles const without type annotation (inferred type)", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export const NAME = "hello";`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("NAME");
    const sig = getSignature(varDecl);
    expect(sig).toBe('const NAME: "hello"');
  });

  it("handles generic arrow functions", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export const identity = <T>(x: T): T => x;`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("identity");
    const sig = getSignature(varDecl);
    expect(sig).toBe("const identity = <T>(x: T): T => ...");
  });
});
