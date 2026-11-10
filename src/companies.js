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
      const exactMatch = companies.some((company) => company.name?.toLowerCase() === name.toLowerCase());
      return ok({
        companies, page, limit, has_more: window.length > limit,
        exact_match: exactMatch,
        ...(!exactMatch ? {
          hint: 'The short name may be a Tradename. Check the candidates with get_company_profile_values.',
        } : {}),
      });
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
    'get_company_profile_values',
    'Get custom profile field values for a company, including Tradename. Returns field_id, value_id, field_name, field_type, and value. Read-only.',
    {
      company_id: z.string().regex(/^\d+$/, 'company_id must be a numeric ID').describe('Numeric Accelo company ID'),
      field_id: z.string().regex(/^\d+$/, 'field_id must be a numeric ID').optional().describe('Return only this profile-field definition ID'),
    },
    async ({ company_id, field_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/companies/${encodeURIComponent(company_id)}/profiles/values`, {
        _fields: 'id,value,field_id,field_name,field_type',
        _limit: 100,
      });
      if (!Array.isArray(json.response)) throw new Error('Accelo company profile values returned an invalid response.');
      return ok(json.response.map((row) => {
        const valueId = row.value_id ?? row.id ?? null;
        return {
          id: valueId,
          field_id: row.field_id ?? row.profile_field_id ?? row.field?.id ?? row.profile_field?.id ?? null,
          value_id: valueId,
          field_name: row.field_name ?? row.profile_field_name ?? row.field?.name ?? row.profile_field?.name ?? null,
          field_type: row.field_type ?? row.profile_field_type ?? row.field?.type ?? row.profile_field?.type ?? null,
          value: row.value,
        };
      }).filter((row) => field_id === undefined || String(row.field_id) === field_id));
    }
  );

  server.tool(
    'get_matter_contacts',
    'Get the matter’s own client affiliation and a company-verified contact roster for a job or issue. Returns roster_filter on success or roster_error listing failed filters without roster rows. The own affiliation is always preserved. Read-only.',
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
      const fields = 'id,contact(id,firstname,surname,email),email,phone,mobile,position,company,standing';
      const ownResponse = (await acceloGet(token, `/affiliations/${encodeURIComponent(ownAffiliationId)}`, {
        _fields: fields,
      })).response;
      const ownAffiliation = Array.isArray(ownResponse) ? ownResponse[0] : ownResponse;
      if (!ownAffiliation) throw new Error('Accelo affiliation lookup returned no record.');
      const companyId = relationId(matter.company) ?? matter.company_id ??
        relationId(ownAffiliation.company) ?? ownAffiliation.company_id;
      const toContact = (row) => {
        const contact = row.contact && typeof row.contact === 'object' ? row.contact : row;
        const affiliationId = relationId(row) ?? row.affiliation_id ?? null;
        return {
          id: relationId(row.contact) ?? row.contact_id ?? contact.id ?? null,
          contact_id: relationId(row.contact) ?? row.contact_id ?? contact.id ?? null,
          firstname: contact.firstname ?? null,
          surname: contact.surname ?? null,
          name: contact.name ?? ([contact.firstname, contact.surname].filter(Boolean).join(' ') || row.name || null),
          email: contact.email ?? row.email ?? null,
          phone: contact.phone ?? row.phone ?? null,
          mobile: row.mobile ?? contact.mobile ?? null,
          affiliation_id: affiliationId,
          position: row.position ?? contact.position ?? null,
          role: row.role ?? contact.role ?? null,
          standing: row.standing ?? contact.standing ?? null,
          is_matter_affiliation: String(affiliationId) === String(ownAffiliationId),
        };
      };
      const result = {
        against_type,
        against_id,
        affiliation_id: String(ownAffiliationId),
        contacts: [toContact({ ...ownAffiliation, id: ownAffiliationId })],
        has_more: false,
      };
      try {
        if (companyId == null) throw new Error('Matter affiliation has no resolvable company ID.');
        const fetchRoster = (filter) => fetchWindow(async (upstreamPage, size) => {
          const json = await acceloGet(token, '/affiliations', {
            _filters: filter,
            _fields: fields,
            _limit: size,
            _page: upstreamPage,
          });
          if (!Array.isArray(json.response)) throw new Error('Accelo company affiliations returned an invalid response.');
          const mismatchCount = json.response.filter((row) =>
            String(relationId(row.company) ?? row.company_id) !== String(companyId)).length;
          if (mismatchCount) {
            throw Object.assign(new Error('Company affiliation filter was not applied.'), { mismatch_count: mismatchCount });
          }
          return json.response;
        }, 100, 0);
        const failures = [];
        let mismatchCount;
        for (const [name, filter] of [
          ['company', `company(${companyId})`],
          ['company_id', `company_id(${companyId})`],
          ['against_type,against_id', `against_type(company),against_id(${companyId})`],
        ]) {
          try {
            const window = await fetchRoster(filter);
            result.contacts.push(...window.slice(0, 100)
              .filter((row) => String(relationId(row)) !== String(ownAffiliationId))
              .map(toContact));
            result.has_more = window.length > 100;
            result.roster_filter = name;
            return ok(result);
          } catch (error) {
            failures.push(`${filter}: ${error.mismatch_count ? `mismatch:${error.mismatch_count}` : error.status ?? 'error'}`);
            mismatchCount = error.mismatch_count ?? mismatchCount;
          }
        }
        result.roster_error = failures.join('; ');
        if (mismatchCount) {
          result.status = 'filter_not_applied';
          result.mismatch_count = mismatchCount;
        }
      } catch (error) {
        result.roster_error = `${error.status ?? 'error'} Matter affiliation has no resolvable company roster.`;
      }
      return ok(result);
    }
  );
}
