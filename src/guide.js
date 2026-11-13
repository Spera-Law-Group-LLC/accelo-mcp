// #115(a): Firm-approved matter/against mapping; see activities.js:137-156.
// #115(b): Contact detail fields are returned from affiliations; see companies.js:147-170.
// #115(c): Time unit guidance from activities.js:43-44 and the issue evaluation.
// #115(d): Numeric enum ID guidance from the issue evaluation.
// #115(e): Linked-field syntax guidance from the issue evaluation.
// #115(f): Filter negation guidance from the issue evaluation.
// #115(g): Activity search limitation and safe existing-tool workflow from issue #11 and #115.
// #115(h): Date unit guidance from activities.js:53 and projects.js:38.
export const ACCELO_GUIDE = `Accelo guide

• Activities attach to a parent with against_type and against_id. A legal matter is an Accelo job or issue; use the corresponding type and ID when calling list_activities or get_activity_thread.
• Contact email, phone, mobile, and position belong to the affiliation, not the contact record. Use get_matter_contacts to see the matter's affiliation details.
• Activity and task time values—including billable, nonbillable, logged, budgeted, and remaining time—are measured in seconds.
• Status, type, and priority filters require numeric IDs, not display names. Use the numeric IDs supplied by your Accelo deployment.
• Linked objects in _fields use parentheses, for example manager() or postal_address(city).
• Append _not to a filter name to negate that filter.
• GET /activities does not honor _search and has no subject/body filter. Scope by matter first with list_activities or get_activity_thread, then match the subject client-side.
• Dates are Unix timestamps in seconds.`;
