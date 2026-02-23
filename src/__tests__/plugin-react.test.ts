import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import reactPlugin from "../plugins/react.js";
import { generateDocIndex } from "../indexer.js";
import type { ArmillaryPlugin } from "../plugins.js";

// ── Helper ───────────────────────────────────────────────────────────

let tmpDir: string;
let tsConfigPath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-react-"));
  tsConfigPath = path.join(tmpDir, "tsconfig.json");
  await fs.writeFile(
    tsConfigPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        jsx: "react-jsx",
        strict: true,
        esModuleInterop: true,
        moduleResolution: "Bundler",
      },
      include: ["**/*.ts", "**/*.tsx"],
    })
  );

  // Minimal React type stubs so ts-morph can resolve types
  const reactDir = path.join(tmpDir, "node_modules", "@types", "react");
  await fs.mkdir(reactDir, { recursive: true });
  await fs.writeFile(
    path.join(reactDir, "index.d.ts"),
    `
declare namespace React {
  type ReactNode = string | number | boolean | null | undefined | React.ReactElement;
  interface ReactElement<P = any> {
    type: any;
    props: P;
    key: string | null;
  }
  type FC<P = {}> = FunctionComponent<P>;
  interface FunctionComponent<P = {}> {
    (props: P): ReactNode;
    displayName?: string;
  }
  function forwardRef<T, P = {}>(
    render: (props: P, ref: React.Ref<T>) => ReactNode
  ): React.ForwardRefExoticComponent<React.PropsWithoutRef<P> & React.RefAttributes<T>>;
  function memo<P>(
    component: React.FC<P>
  ): React.FC<P>;
  type Ref<T> = { current: T | null } | ((instance: T | null) => void) | null;
  type ForwardRefExoticComponent<P> = React.FC<P>;
  type PropsWithoutRef<P> = P;
  type RefAttributes<T> = { ref?: React.Ref<T> };
}

declare namespace JSX {
  interface Element extends React.ReactElement {}
  interface IntrinsicElements {
    div: any;
    span: any;
    button: any;
    input: any;
    h1: any;
    p: any;
  }
}

export = React;
export as namespace React;
`
  );

  await reactPlugin.init!({ projectRoot: tmpDir, tsConfigFilePath: tsConfigPath });
});

afterAll(async () => {
  await reactPlugin.dispose!();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function extractFromTsx(
  fileName: string,
  code: string
) {
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, code);
  const symbols = await reactPlugin.extractSymbols!(filePath, code);
  return symbols;
}

// ── Component Detection ──────────────────────────────────────────────

describe("component detection", () => {
  it("detects function component returning JSX", async () => {
    const symbols = await extractFromTsx(
      "FuncComp.tsx",
      `export function Greeting() {
  return <div>Hello</div>;
}`
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("component");
    expect(symbols[0].name).toBe("Greeting");
  });

  it("detects arrow function component returning JSX", async () => {
    const symbols = await extractFromTsx(
      "ArrowComp.tsx",
      `export const Card = () => {
  return <div>Card</div>;
};`
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("component");
    expect(symbols[0].name).toBe("Card");
  });

  it("detects React.FC typed component", async () => {
    const symbols = await extractFromTsx(
      "FcComp.tsx",
      `import React from "react";
export const Badge: React.FC<{ label: string }> = ({ label }) => {
  return <span>{label}</span>;
};`
    );
    const badge = symbols.find((s) => s.name === "Badge");
    expect(badge).toBeDefined();
    expect(badge!.kind).toBe("component");
  });

  it("detects forwardRef wrapped component", async () => {
    const symbols = await extractFromTsx(
      "ForwardRefComp.tsx",
      `import React from "react";
export const Input = React.forwardRef<HTMLInputElement, { placeholder: string }>((props, ref) => {
  return <input ref={ref} placeholder={props.placeholder} />;
});`
    );
    const input = symbols.find((s) => s.name === "Input");
    expect(input).toBeDefined();
    expect(input!.kind).toBe("component");
  });

  it("detects memo wrapped component", async () => {
    const symbols = await extractFromTsx(
      "MemoComp.tsx",
      `import React from "react";
export const Expensive = React.memo(({ count }: { count: number }) => {
  return <div>{count}</div>;
});`
    );
    const expensive = symbols.find((s) => s.name === "Expensive");
    expect(expensive).toBeDefined();
    expect(expensive!.kind).toBe("component");
  });

  it("resolves default export function component name", async () => {
    const symbols = await extractFromTsx(
      "DefaultComp.tsx",
      `export default function App() {
  return <div>App</div>;
}`
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("App");
    expect(symbols[0].kind).toBe("component");
    expect(symbols[0].id).toContain("#App");
  });

  it("leaves non-PascalCase functions unchanged (hooks)", async () => {
    const symbols = await extractFromTsx(
      "hooks.tsx",
      `export function useCounter() {
  return { count: 0 };
}`
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].name).toBe("useCounter");
  });

  it("leaves non-component exports unchanged (interfaces, types)", async () => {
    const symbols = await extractFromTsx(
      "types.tsx",
      `export interface ButtonProps {
  label: string;
  onClick: () => void;
}
export type Size = "sm" | "md" | "lg";`
    );
    const iface = symbols.find((s) => s.name === "ButtonProps");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");

    const typeAlias = symbols.find((s) => s.name === "Size");
    expect(typeAlias).toBeDefined();
    expect(typeAlias!.kind).toBe("type");
  });

  it("leaves utility constants unchanged", async () => {
    const symbols = await extractFromTsx(
      "constants.tsx",
      `export const MAX_ITEMS = 100;`
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("const");
  });
});

// ── Props Extraction ─────────────────────────────────────────────────

describe("props extraction", () => {
  it("extracts props from function parameter type", async () => {
    const symbols = await extractFromTsx(
      "PropsFunc.tsx",
      `interface ButtonProps {
  label: string;
  disabled: boolean;
}
export function Button(props: ButtonProps) {
  return <button disabled={props.disabled}>{props.label}</button>;
}`
    );
    const btn = symbols.find((s) => s.name === "Button");
    expect(btn).toBeDefined();
    expect(btn!.kind).toBe("component");
    expect(btn!.params).toBeDefined();
    const names = btn!.params!.map((p) => p.name);
    expect(names).toContain("disabled");
    expect(names).toContain("label");
    // Should be sorted alphabetically
    expect(names).toEqual([...names].sort());
  });

  it("extracts props from destructured parameter", async () => {
    const symbols = await extractFromTsx(
      "PropsDestructured.tsx",
      `interface TagProps {
  text: string;
  color: string;
}
export const Tag = ({ text, color }: TagProps) => {
  return <span style={{ color }}>{text}</span>;
};`
    );
    const tag = symbols.find((s) => s.name === "Tag");
    expect(tag).toBeDefined();
    expect(tag!.kind).toBe("component");
    expect(tag!.params).toBeDefined();
    const names = tag!.params!.map((p) => p.name);
    expect(names).toContain("text");
    expect(names).toContain("color");
  });

  it("extracts props from React.FC generic", async () => {
    const symbols = await extractFromTsx(
      "PropsFc.tsx",
      `import React from "react";
interface AlertProps {
  message: string;
  severity: string;
}
export const Alert: React.FC<AlertProps> = ({ message, severity }) => {
  return <div>{severity}: {message}</div>;
};`
    );
    const alert = symbols.find((s) => s.name === "Alert");
    expect(alert).toBeDefined();
    expect(alert!.kind).toBe("component");
    expect(alert!.params).toBeDefined();
    const names = alert!.params!.map((p) => p.name);
    expect(names).toContain("message");
    expect(names).toContain("severity");
  });

  it("extracts JSDoc descriptions on props", async () => {
    const symbols = await extractFromTsx(
      "PropsJsdoc.tsx",
      `interface InfoProps {
  /** The display title */
  title: string;
  /** Whether the info box is visible */
  visible: boolean;
}
export function Info(props: InfoProps) {
  return <div>{props.title}</div>;
}`
    );
    const info = symbols.find((s) => s.name === "Info");
    expect(info).toBeDefined();
    expect(info!.params).toBeDefined();
    const titleParam = info!.params!.find((p) => p.name === "title");
    expect(titleParam).toBeDefined();
    expect(titleParam!.description).toBe("The display title");
    const visibleParam = info!.params!.find((p) => p.name === "visible");
    expect(visibleParam!.description).toBe("Whether the info box is visible");
  });

  it("handles component with no props", async () => {
    const symbols = await extractFromTsx(
      "NoProps.tsx",
      `export function Logo() {
  return <div>Logo</div>;
}`
    );
    const logo = symbols.find((s) => s.name === "Logo");
    expect(logo).toBeDefined();
    expect(logo!.kind).toBe("component");
    // No params or empty params
    expect(logo!.params ?? []).toHaveLength(0);
  });

  it("extracts props from forwardRef callback", async () => {
    const symbols = await extractFromTsx(
      "PropsForwardRef.tsx",
      `import React from "react";
interface FieldProps {
  name: string;
  value: string;
}
export const Field = React.forwardRef<HTMLInputElement, FieldProps>((props, ref) => {
  return <input ref={ref} name={props.name} value={props.value} />;
});`
    );
    const field = symbols.find((s) => s.name === "Field");
    expect(field).toBeDefined();
    expect(field!.kind).toBe("component");
    expect(field!.params).toBeDefined();
    const names = field!.params!.map((p) => p.name);
    expect(names).toContain("name");
    expect(names).toContain("value");
  });
});

// ── Indexer Deduplication ────────────────────────────────────────────

describe("indexer deduplication", () => {
  it("does not double-process .tsx files when React plugin is active", async () => {
    const indexTmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "armillary-dedup-")
    );

    try {
      await fs.writeFile(
        path.join(indexTmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            jsx: "react-jsx",
            strict: true,
            moduleResolution: "Bundler",
          },
          include: ["**/*.ts", "**/*.tsx"],
        })
      );

      // React type stubs
      const reactDir = path.join(
        indexTmpDir,
        "node_modules",
        "@types",
        "react"
      );
      await fs.mkdir(reactDir, { recursive: true });
      await fs.writeFile(
        path.join(reactDir, "index.d.ts"),
        `
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements { div: any; }
}
declare namespace React {
  type ReactNode = any;
  type FC<P = {}> = (props: P) => ReactNode;
}
export = React;
export as namespace React;
`
      );

      await fs.writeFile(
        path.join(indexTmpDir, "App.tsx"),
        `export function App() { return <div>Hello</div>; }`
      );
      await fs.writeFile(
        path.join(indexTmpDir, "utils.ts"),
        `export function helper() { return 42; }`
      );

      // Create a fresh plugin instance for this test
      const plugin: ArmillaryPlugin = {
        ...reactPlugin,
        // Use a spy to count invocations
        extractSymbols: reactPlugin.extractSymbols!,
      };

      const index = await generateDocIndex({
        tsConfigFilePath: path.join(indexTmpDir, "tsconfig.json"),
        projectRoot: indexTmpDir,
        outputPath: path.join(indexTmpDir, "out.json"),
        plugins: [plugin],
      });

      // App should appear exactly once
      const appSymbols = index.symbols.filter((s) => s.name === "App");
      expect(appSymbols).toHaveLength(1);
      expect(appSymbols[0].kind).toBe("component");

      // utils.ts should still be indexed normally
      const helperSymbol = index.symbols.find((s) => s.name === "helper");
      expect(helperSymbol).toBeDefined();
      expect(helperSymbol!.kind).toBe("function");
    } finally {
      await fs.rm(indexTmpDir, { recursive: true, force: true });
    }
  });

  it("still indexes .ts files normally alongside React plugin", async () => {
    const indexTmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "armillary-dedup2-")
    );

    try {
      await fs.writeFile(
        path.join(indexTmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            jsx: "react-jsx",
            strict: true,
            moduleResolution: "Bundler",
          },
          include: ["**/*.ts", "**/*.tsx"],
        })
      );

      await fs.writeFile(
        path.join(indexTmpDir, "api.ts"),
        `export function fetchData() { return Promise.resolve([]); }
export const API_URL = "https://example.com";`
      );

      const index = await generateDocIndex({
        tsConfigFilePath: path.join(indexTmpDir, "tsconfig.json"),
        projectRoot: indexTmpDir,
        outputPath: path.join(indexTmpDir, "out.json"),
        plugins: [reactPlugin],
      });

      const fetchSymbol = index.symbols.find((s) => s.name === "fetchData");
      expect(fetchSymbol).toBeDefined();
      expect(fetchSymbol!.kind).toBe("function");

      const urlSymbol = index.symbols.find((s) => s.name === "API_URL");
      expect(urlSymbol).toBeDefined();
      expect(urlSymbol!.kind).toBe("const");
    } finally {
      await fs.rm(indexTmpDir, { recursive: true, force: true });
    }
  });
});
