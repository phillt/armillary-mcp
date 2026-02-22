import { z } from "zod";

export const ParamSchema = z.object({
    name: z.string(),
    type: z.string().optional(),
    description: z.string().optional(),
});

export const SymbolDocSchema = z.object({
    id: z.string(),                 // stable id: `${filePath}#${exportName}`
    kind: z.enum(["function", "class", "type", "const", "interface", "enum", "component"]),
    name: z.string(),
    filePath: z.string(),
    exported: z.boolean(),
    signature: z.string().optional(),
    description: z.string().optional(),
    params: z.array(ParamSchema).optional(),
    returns: z.object({ type: z.string().optional(), description: z.string().optional() }).optional(),
    tags: z.record(z.string(), z.string()).optional()
});

export const DocIndexSchema = z.object({
    version: z.string(),
    generatedAt: z.string(),
    projectRoot: z.string(),
    symbols: z.array(SymbolDocSchema),
});

export type DocIndex = z.infer<typeof DocIndexSchema>;
export type SymbolDoc = z.infer<typeof SymbolDocSchema>;