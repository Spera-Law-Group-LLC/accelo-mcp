import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';
import { fetchWindow } from './pagination.js';
import { acceloGet } from './accelo.js';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function companyUrl(id) {
  const apiUrl = new URL(config.acceloBaseUrl);
  apiUrl.hostname = apiUrl.hostname.replace(/\.api\.accelo\.com$/, '.accelo.com');
  return new URL(`/?action=view_company&id=${encodeURIComponent(id)}`, apiUrl.origin).toString();
}

function relationId(value) {
  return value && typeof value === 'object'
    ? value.id ?? value.affiliation_id ?? value.company_id ?? null
    : value ?? null;
}

export function registerCompanyTools(server, subject) {
  server.tool(
    'search_companies',
    'Search Accelo companies by name. Returns ID, name, standing/status, and a stable Accelo link. Pages are zero-based; when has_more is true, request the next page with the same limit. Read-only.',
    {
      name: z.string().min(1).max(200).describe('Company name to search for'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results per page (default 50)'),
      page: z.number().int().min(0).max(10000).optional().describe('Zero-based page number'),
    },
    async ({ name, limit = 50, page = 0 }) => {
      const token = await getValidAcceloToken(subject);
      const window = await fetchWindow(async (upstreamPage, size) => {
        const json = await acceloGet(token, '/companies', {
          _search: name,
          _fields: 'id,name,standing,status',
          _limit: size,
          _page: upstreamPage,
        });
        if (!Array.isArray(json.response)) throw new Error('Accelo company search returned an invalid response.');
        return json.response;
      }, limit, page);
      const companies = window.slice(0, limit).map((company) => ({
        id: company.id,
        name: company.name,
        standing: company.standing,
        status: company.status,
        url: companyUrl(company.id),
      }));
      return ok({ companies, page, limit, has_more: window.length > limit });
    }
  );

  server.tool(
    'get_company',
    'Get an Accelo company by ID, including its standing, website, phone, and creation date. Read-only.',
    { company_id: z.string().regex(/^\d+$/, 'company_id must be a numeric ID').describe('Numeric Accelo company ID') },
    async ({ company_id }) => {
      const token = await getValidAcceloToken(subject);
      let json;
      try {
        json = await acceloGet(token, `/companies/${encodeURIComponent(company_id)}`, {
          _fields: 'id,name,standing,status,website,phone,date_created',
        });
      } catch (error) {
        if (error.status === 400 || error.status === 404) {
          return ok({ status: 'not_found', object_type: 'company' });
        }
        throw error;
      }
      const company = Array.isArray(json.response) ? json.response[0] : json.response;
      if (!company || company.id == null) return ok({ status: 'not_found', object_type: 'company' });
      return ok({
        id: company.id,
        name: company.name,
        standing: company.standing,
        status: company.status,
        website: company.website,
        phone: company.phone,
        date_created: company.date_created,
        url: companyUrl(company.id),
      });
    }
  );

  server.tool(
    'get_matter_contacts',
    'List contacts affiliated with a job or issue and identify the matter’s own client affiliation. Read-only.',
    {
      against_type: z.enum(['job', 'issue']).describe('Matter type'),
      against_id: z.string().regex(/^\d+$/, 'against_id must be a numeric ID').describe('Numeric matter ID'),
    },
    async ({ against_type, against_id }) => {
      const token = await getValidAcceloToken(subject);
      const matter = (await acceloGet(token, `/${against_type}s/${encodeURIComponent(against_id)}`, {
        _fields: 'id,company,company_id,affiliation,affiliation_id',
      })).response;
      if (!matter) throw new Error(`Accelo ${against_type} lookup returned no record.`);
      const ownAffiliationId = relationId(matter.affiliation) ?? matter.affiliation_id ?? null;
      if (ownAffiliationId == null) {
        return ok({
          against_type,
          against_id,
          affiliation_id: null,
          status: 'no_affiliation',
          contacts: [],
          has_more: false,
        });
      }
      const companyId = relationId(matter.company) ?? matter.company_id ??
        relationId(matter.affiliation?.company) ?? matter.affiliation?.company_id;
      if (companyId == null) throw new Error('Matter affiliation has no resolvable company ID.');

      // The nested affiliations route is documented in the issue but cannot be verified live here.
      // Keep failures visible rather than treating an unsupported endpoint as an empty result.
      const window = await fetchWindow(async (upstreamPage, size) => {
        const json = await acceloGet(token, `/companies/${encodeURIComponent(companyId)}/affiliations`, {
          _fields: '_ALL',
          _limit: size,
          _page: upstreamPage,
        });
        if (!Array.isArray(json.response)) throw new Error('Accelo company affiliations returned an invalid response.');
        return json.response;
      }, 100, 0);
      const contacts = window.slice(0, 100).map((row) => {
        const contact = row.contact && typeof row.contact === 'object' ? row.contact : row;
        const affiliationId = relationId(row) ?? row.affiliation_id ?? null;
        return {
          id: relationId(row.contact) ?? row.contact_id ?? contact.id ?? null,
          name: contact.name ?? row.name ?? null,
          email: contact.email ?? row.email ?? null,
          phone: contact.phone ?? row.phone ?? null,
          affiliation_id: affiliationId,
          position: row.position ?? contact.position ?? null,
          role: row.role ?? contact.role ?? null,
          is_matter_affiliation: String(affiliationId) === String(ownAffiliationId),
        };
      });
      return ok({
        against_type,
        against_id,
        affiliation_id: String(ownAffiliationId),
        contacts,
        has_more: window.length > contacts.length,
      });
    }
  );
}
