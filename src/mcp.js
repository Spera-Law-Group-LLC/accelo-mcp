import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as accelo from './accelo.js';
import { getValidAcceloToken } from './oauth.js';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Build a fresh MCP server bound to a specific authenticated subject
// (i.e. one Accelo user). All Accelo calls run as that user, so Accelo's
// own permission model is respected.
export function buildServer(subject) {
  const server = new McpServer({ name: 'accelo-mcp', version: '0.1.0' });

  server.tool(
    'list_quotes',
    'List or search quotes in Accelo. Returns only quotes the authorized user can see.',
    {
      search: z.string().optional().describe('Free-text search across the quote title'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
      page: z.number().int().min(0).optional().describe('Zero-based page number'),
      filters: z.string().optional().describe("Raw Accelo _filters expression, e.g. standing(active)"),
    },
    async ({ search, limit, page, filters }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.listQuotes(token, { search, limit, page, filters }));
    }
  );

  server.tool(
    'get_quote',
    'Get a single Accelo quote by its ID.',
    { id: z.string().describe('The quote ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.getQuote(token, id));
    }
  );

  server.tool(
    'create_quote',
    'Create a new Accelo quote. title is required; other Accelo quote fields may be supplied.',
    {
      title: z.string().describe('Quote title'),
      against_type: z.string().optional().describe("Object type the quote is against, e.g. 'company' or 'prospect'"),
      against_id: z.string().optional().describe('ID of the object the quote is against'),
      notes: z.string().optional().describe('Quote notes / body'),
      fields: z.record(z.string()).optional().describe('Any additional Accelo quote fields as key/value pairs'),
    },
    async ({ title, against_type, against_id, notes, fields }) => {
      const token = await getValidAcceloToken(subject);
      const body = {
        title,
        ...(against_type ? { against_type } : {}),
        ...(against_id ? { against_id } : {}),
        ...(notes ? { notes } : {}),
        ...(fields || {}),
      };
      return ok(await accelo.createQuote(token, body));
    }
  );

  server.tool(
    'update_quote',
    'Update an existing Accelo quote by ID. Only the provided fields are changed.',
    {
      id: z.string().describe('The quote ID to update'),
      title: z.string().optional().describe('New quote title'),
      notes: z.string().optional().describe('New quote notes / body'),
      fields: z.record(z.string()).optional().describe('Any additional Accelo quote fields as key/value pairs'),
    },
    async ({ id, title, notes, fields }) => {
      const token = await getValidAcceloToken(subject);
      const body = {
        ...(title !== undefined ? { title } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(fields || {}),
      };
      return ok(await accelo.updateQuote(token, id, body));
    }
  );

  return server;
}
