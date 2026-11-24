import { SERVER_INFO } from './meta';
import { TOOLS } from './tools';

/** OpenAPI 3.1 description of the agent REST API, generated from the same tool list the MCP server uses. */
export function openapi(origin: string) {
  const paths: Record<string, unknown> = {};
  for (const t of TOOLS) {
    const params = Object.entries(t.input.properties).map(([name, schema]) => ({
      name,
      in: 'query',
      required: (t.input.required ?? []).includes(name),
      description: (schema as { description?: string }).description,
      schema: name === 'filters' ? { type: 'string', description: 'JSON object, e.g. {"source":"X"}' } : schema,
    }));
    const errors = {
      '400': { description: 'Bad arguments' },
      '401': { description: 'Missing or invalid token' },
      '403': { description: 'Token lacks the scope' },
      '404': { description: 'Not found (a site of another account answers the same as a missing one)' },
    };
    const post = {
      operationId: t.scope === 'write' ? t.name : `${t.name}_post`,
      summary: t.title,
      description: t.description,
      'x-datamonster-scope': t.scope,
      requestBody: { required: true, content: { 'application/json': { schema: t.input } } },
      responses: { '200': { description: 'OK' }, ...errors, ...(t.scope === 'write' ? { '409': { description: 'Conflicts with existing data' } } : {}) },
    };
    // Write tools change data, so they are POST only; read tools take GET with query arguments or POST.
    paths[`/api/agent/v1/${t.name}`] =
      t.scope === 'write'
        ? { post }
        : {
            get: {
              operationId: t.name,
              summary: t.title,
              description: t.description,
              'x-datamonster-scope': t.scope,
              parameters: params,
              responses: { '200': { description: 'OK' }, ...errors },
            },
            post,
          };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'DataMonster agent API',
      version: SERVER_INFO.version,
      description:
        'Read revenue analytics from your own DataMonster install, and (with the write scope) create tagged links and annotations, configure public online widgets, and record and check launches. The same tools are served over MCP at /api/agent/mcp.',
    },
    servers: [{ url: origin }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'An agent token (dm_...) created in the dashboard.' } } },
    security: [{ token: [] }],
    paths,
  };
}
