// metadata-filter.js
// Responsible for fetching the $metadata EDMX document from Dataverse
// and stripping out tables and columns the AppSheet doesn't need to know about.

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetches $metadata from Dataverse and applies the configured filters before
 * returning it to the caller. If both filters are disabled, the raw XML is
 * returned as-is to avoid any unnecessary processing overhead.
 *
 * @param {object} opts
 * @param {string}  opts.dataverseOrgUrl        - Dataverse base URL (no trailing slash)
 * @param {string}  opts.accessToken            - Valid Bearer token
 * @param {string}  opts.originalUrl            - Original request path (e.g. /api/data/v9.2/$metadata)
 * @param {boolean} opts.includeSystemTables    - Pass-through system tables (account, contact, etc.)
 * @param {boolean} opts.filterColumnsByPrefix  - Remove non-prefixed columns from user tables
 * @param {string}  opts.tablePrefix            - Publisher prefix (e.g. "cr5d4")
 */
export async function fetchAndFilterMetadata({
  dataverseOrgUrl,
  accessToken,
  originalUrl,
  includeSystemTables,
  filterColumnsByPrefix,
  tablePrefix
}) {
  const metadataUrl = `${dataverseOrgUrl}${originalUrl}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(metadataUrl, {
      headers: {
        'Authorization':    `Bearer ${accessToken}`,
        'Accept':           'application/xml,text/xml',
        'Accept-Encoding':  'gzip, deflate, br',
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(err.name === 'AbortError'
      ? `$metadata request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : err.message
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Dataverse $metadata HTTP ${response.status}: ${errText}`);
  }

  const rawXml = await response.text();
  const contentType = response.headers.get('content-type') || 'application/xml;charset=utf-8';

  // No filters configured — pass through untouched
  if (includeSystemTables && !filterColumnsByPrefix) {
    return { xml: rawXml, contentType };
  }

  try {
    const filteredXml = applyFilters(rawXml, { includeSystemTables, filterColumnsByPrefix, tablePrefix });
    return { xml: filteredXml, contentType };
  } catch (err) {
    // If anything goes wrong during filtering, fall back to the raw XML.
    // This ensures AppSheet never gets a corrupted/empty schema.
    console.error('[Metadata] Filtering failed, falling back to raw XML:', err.message);
    return { xml: rawXml, contentType };
  }
}

// ---------------------------------------------------------------------------
// Internal filtering logic
// ---------------------------------------------------------------------------

/**
 * Applies the configured filters to the raw EDMX XML string.
 * Works entirely with regex on the raw string — intentionally avoids DOM
 * parsing to keep memory usage low, since the $metadata doc can be 6MB+.
 *
 * The Dataverse EDMX is always a single line, so [\s\S] is not strictly needed,
 * but kept for safety in case the response is ever formatted with newlines.
 */
function applyFilters(xml, { includeSystemTables, filterColumnsByPrefix, tablePrefix }) {
  const prefix = tablePrefix.toLowerCase();

  // Tracks which EntityType names survived filtering so we can sync EntitySets.
  const keptEntities = new Set();

  // --- Step 1: Filter EntityType blocks ---
  // Each non-abstract EntityType represents one OData table.
  // NOTE: Some EntityTypes are self-closing (e.g. <EntityType Name="crmbaseentity" Abstract="true" />)
  // — these are base types with no properties and we leave them alone regardless.
  let filtered = xml.replace(/<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/g, (match, attrs, body) => {
    const nameMatch = /\bName="([^"]*)"/.exec(attrs);
    if (!nameMatch) return match;

    const entityName = nameMatch[1];
    const isUserTable = entityName.toLowerCase().startsWith(prefix);

    // System table (e.g. account, contact) — remove if opted out
    if (!isUserTable && !includeSystemTables) {
      return '';
    }

    keptEntities.add(entityName);

    // User table with column filtering enabled — strip non-prefixed Property elements.
    // Properties in OData EDMX are self-closing: <Property Name="..." Type="..." />
    // We use a lazy pattern with optional whitespace before /> to safely capture the attributes.
    if (isUserTable && filterColumnsByPrefix) {
      // Locate the primary key name from the Key block — it must always survive the filter
      const keyRefMatch = /<PropertyRef\s+Name="([^"]*)"/.exec(body);
      const primaryKey = keyRefMatch ? keyRefMatch[1] : null;

      const filteredBody = body.replace(/<Property\b([^>]*?)\s*\/>/g, (propMatch, propAttrs) => {
        const propNameMatch = /\bName="([^"]*)"/.exec(propAttrs);
        if (!propNameMatch) return propMatch;
        const propName = propNameMatch[1];

        // Primary key is sacred — always keep it
        if (primaryKey && propName === primaryKey) return propMatch;

        // Keep only columns that share the publisher prefix
        if (propName.toLowerCase().startsWith(prefix)) return propMatch;

        return ''; // Strip everything else
      });

      return `<EntityType${attrs}>${filteredBody}</EntityType>`;
    }

    return match;
  });

  // Safety check: if we removed system tables but keptEntities is somehow empty,
  // bail out and return the original xml to avoid an empty schema.
  if (!includeSystemTables && keptEntities.size === 0) {
    console.error('[Metadata] keptEntities is empty — check DATAVERSE_TABLE_PREFIX. Returning unfiltered XML.');
    return xml;
  }

  return filtered;
}
