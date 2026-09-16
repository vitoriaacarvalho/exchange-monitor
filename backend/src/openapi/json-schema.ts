import { z } from 'zod';

/**
 * The only module that calls Zod's JSON Schema converter, so the `io` direction
 * below is settled once rather than at every call site.
 */

/**
 * Response schemas register themselves here, and `components.schemas` is built
 * from it. Registration is also what turns a nested schema into a `$ref`
 * instead of an inlined copy.
 */
export const registry = z.registry<{ id: string }>();

export function ref(id: string): { $ref: string } {
  return { $ref: `#/components/schemas/${id}` };
}

const CONVERSION_OPTIONS = {
  // 3.1's schema object *is* JSON Schema 2020-12, so this output drops in
  // unmodified. 3.0 would need a rewriting pass over `type: [x, 'null']`.
  target: 'draft-2020-12',

  // Always the input direction: OpenAPI documents what the caller sends, and
  // `io: 'output'` throws `Transforms cannot be represented in JSON Schema` on
  // four of the seven request schemas. What the input side loses — the email
  // format, the `usd-brl` shape — comes back through `.meta()` on the schema
  // itself, in `src/schemas/`.
  io: 'input',

  uri: (id: string) => ref(id).$ref,
} as const;

/** Both are legal JSON Schema and illegal in an OpenAPI schema object. */
function withoutJsonSchemaKeys({
  $schema,
  $id,
  ...rest
}: Record<string, unknown>): Record<string, unknown> {
  return rest;
}

export function toOpenApiSchema(schema: z.ZodType): Record<string, unknown> {
  return withoutJsonSchemaKeys(z.toJSONSchema(schema, CONVERSION_OPTIONS));
}

export function toComponentSchemas(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(registry, CONVERSION_OPTIONS);

  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => [id, withoutJsonSchemaKeys(schema)]),
  );
}
