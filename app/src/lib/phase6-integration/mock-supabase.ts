/**
 * Phase 6 Integration Test - Mock Supabase Client
 *
 * Provides a minimal in-memory Supabase-compatible mock that implements
 * exactly the subset of the real Supabase PostgREST API used by Phase 6D.
 */

// --- Mock Supabase Client ---

interface DbRow {
  id?: string;
  [key: string]: unknown;
}

// Type for tracking the expected row shape from .returns() - can be a single row or array
type RowShape = DbRow | DbRow[];

class MockQueryBuilder<TRow extends RowShape = DbRow> {
  private tables: Map<string, DbRow[]>;
  private tableName: string;
  private selectedColumns: string = "*";
  private eqFilters: Array<{ col: string; val: unknown }> = [];
  private inFilters: Array<{ col: string; vals: unknown[] }> = [];
  private orderCols: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private insertData: DbRow | DbRow[] | null = null;
  private lastInsertId: string | null = null;
  private isUpdateChain: boolean = false;
  private isDeleteChain: boolean = false;
  private client: MockSupabaseClient;

  constructor(tables: Map<string, DbRow[]>, tableName: string, client: MockSupabaseClient) {
    this.tables = tables;
    this.tableName = tableName;
    this.client = client;
  }

  private getTableRows(): DbRow[] {
    return this.tables.get(this.tableName) ?? [];
  }

  insert(data: DbRow | DbRow[]): this {
    this.isUpdateChain = false;
    // Handle both single row and bulk insert (array)
    if (Array.isArray(data)) {
      const rowsToInsert = data.map(d => ({ ...d, id: d.id ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` }));
      this.insertData = rowsToInsert;
      this.lastInsertId = rowsToInsert[0]?.id as string;
    } else {
      // Single row
      const rowToInsert = { ...data, id: data.id ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` };
      this.insertData = rowToInsert;
      this.lastInsertId = rowToInsert.id as string;
    }
    return this;
  }

  select(columns: string): this {
    this.selectedColumns = columns;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.eqFilters.push({ col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.inFilters.push({ col, vals });
    return this;
  }

  /**
   * Supabase .or() filter string, e.g.
   *   `node_id.in.(abc,def),major_understanding_id.in.(ghi,jkl)`
   * Parse out each (col.in.(vals)) pair and register them as inFilters so the
   * _filter step keeps them. Note: no spaces around commas/parens.
   */
  or(filterString: string): this {
    const re = /(\w+)\.in\.[(]([^)]+)[)]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(filterString)) !== null) {
      const col = m[1];
      const vals = m[2].split(",").map((s) => s.trim());
      this.inFilters.push({ col, vals });
    }
    return this;
  }

  ilike(col: string, val: string): this {
    // Store ilike filter similar to eq
    this.eqFilters.push({ col, val: { type: "ilike", pattern: val } });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCols.push({ col, asc: opts?.ascending ?? true });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  delete(): this {
    this.isDeleteChain = true;
    return this;
  }

  // No-op at runtime, exists for type compatibility with Supabase PostgrestBuilder
  // Returns a new builder with the specified row type for type-safe chaining
  returns<TNewRow extends RowShape>(): MockQueryBuilder<TNewRow> {
    return this as unknown as MockQueryBuilder<TNewRow>;
  }

  /** Make the query builder awaitable (thenable) for `await supabase.from(...).select().eq(...)` */
  then<TResult1, TResult2>(
    onFulfilled?: (value: { data: TRow[]; error: Error | null }) => TResult1 | PromiseLike<TResult1>,
    onRejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  update(data: DbRow): this {
    // Store update data; applied when terminal op (single/execute) runs
    this.isUpdateChain = true;
    this.insertData = data;
    return this;
  }

  maybeSingle(): { data: TRow | null; error: Error | null } {
    if (this.isUpdateChain && this.insertData) {
      // Update chain: apply to all matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        Object.assign(row, this.insertData);
      }
      const result = filtered[0]
        ? { data: (this as any)._project({ ...filtered[0], ...this.insertData }) as TRow, error: null }
        : { data: null, error: null };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: check failure injection first
      if (!this.isUpdateChain && !this.isDeleteChain) {
        if (this.client.shouldFailNext) {
          this.client.shouldFailNext = false;
          return { data: null, error: new Error(this.client.failMessage) };
        }
        if (this.client.shouldFailOnTable === this.tableName) {
          this.client.shouldFailOnTable = null;
          return { data: null, error: new Error(this.client.tableFailMessage) };
        }
      }
      // Insert chain: insert the row(s) and return it
      if (!this.isUpdateChain && !this.isDeleteChain) {
        const table = this.getTableRows();
        if (Array.isArray(this.insertData)) {
          table.push(...this.insertData);
        } else {
          table.push(this.insertData);
        }
        this.tables.set(this.tableName, table);
      }
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: (this as any)._project({ ...row }) as TRow, error: null };
      }
      this._resetChain();
      return { data: null, error: null };
    }
    const results = this._filter();
    if (results.length === 0) return { data: null, error: null };
    return { data: (this as any)._project(results[0]) as TRow, error: null };
  }

  single(): { data: TRow | null; error: Error | null } {
    if (this.isUpdateChain && this.insertData) {
      // Update chain: apply to all matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        Object.assign(row, this.insertData);
      }
      const result = filtered[0]
        ? { data: (this as any)._project({ ...filtered[0], ...this.insertData }) as TRow, error: null }
        : { data: null, error: new Error("No rows found") };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: check failure injection first
      if (!this.isUpdateChain && !this.isDeleteChain) {
        if (this.client.shouldFailNext) {
          this.client.shouldFailNext = false;
          return { data: null, error: new Error(this.client.failMessage) };
        }
        if (this.client.shouldFailOnTable === this.tableName) {
          this.client.shouldFailOnTable = null;
          return { data: null, error: new Error(this.client.tableFailMessage) };
        }
      }
      // Insert chain: insert the row(s) and return it
      if (!this.isUpdateChain && !this.isDeleteChain) {
        const table = this.getTableRows();
        if (Array.isArray(this.insertData)) {
          table.push(...this.insertData);
        } else {
          table.push(this.insertData);
        }
        this.tables.set(this.tableName, table);
      }
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: (this as any)._project({ ...row }) as TRow, error: null };
      }
      this._resetChain();
      return { data: null, error: new Error("No rows found") };
    }
    const results = this._filter();
    if (results.length === 0) return { data: null, error: new Error("No rows found") };
    if (results.length > 1) return { data: null, error: new Error("Multiple rows") };
    return { data: (this as any)._project(results[0]) as TRow, error: null };
  }

  execute(): { data: TRow[]; error: Error | null } {
    // Check for failure injection on insert chains
    if (this.insertData && this.lastInsertId && !this.isUpdateChain && !this.isDeleteChain) {
      if (this.client.shouldFailNext) {
        this.client.shouldFailNext = false;
        return { data: [], error: new Error(this.client.failMessage) };
      }
      if (this.client.shouldFailOnTable === this.tableName) {
        this.client.shouldFailOnTable = null;
        return { data: [], error: new Error(this.client.tableFailMessage) };
      }
    }

    if (this.isUpdateChain && this.insertData) {
      // Check for failure injection on update chains
      if (this.client.shouldFailOnTable === this.tableName) {
        this.client.shouldFailOnTable = null;
        return { data: [], error: new Error(this.client.tableFailMessage) };
      }
      // Update chain: apply to all matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        Object.assign(row, this.insertData);
      }
      const result = { data: filtered.map((r) => (this as any)._project({ ...r, ...this.insertData! })) as TRow[], error: null };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: insert the row(s) and return it
      if (!this.isUpdateChain && !this.isDeleteChain) {
        const table = this.getTableRows();
        if (Array.isArray(this.insertData)) {
          table.push(...this.insertData);
        } else {
          table.push(this.insertData);
        }
        this.tables.set(this.tableName, table);
      }
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: [(this as any)._project({ ...row }) as TRow], error: null };
      }
      this._resetChain();
      return { data: [], error: null };
    }
    if (this.isDeleteChain) {
      // Delete chain: delete matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        const table = this.getTableRows();
        const index = table.findIndex(r => r.id === row.id);
        if (index !== -1) {
          table.splice(index, 1);
        }
      }
      this._resetChain();
      return { data: [], error: null };
    }
    // Select query: apply limit if set
    let filtered = this._filter();
    if (this.limitN !== null) {
      filtered = filtered.slice(0, this.limitN);
    }
    return { data: filtered.map((r) => (this as any)._project(r) as TRow), error: null };
  }

  private _resetChain(): void {
    this.isUpdateChain = false;
    this.insertData = null;
    this.lastInsertId = null;
  }

  private _filter(): DbRow[] {
    let result: DbRow[] = [...this.getTableRows()];

    for (const { col, val } of this.eqFilters) {
      result = result.filter((row: DbRow) => {
        // Handle JSONB path queries (e.g., "notes->>acquisition_job_id") FIRST
        // because row[col] will be undefined for such columns
        if (col.includes("->>")) {
          const parts = col.split("->>");
          const jsonCol = parts[0];
          const jsonKey = parts[1];
          const raw = row[jsonCol];
          if (typeof raw === "string") {
            try {
              const parsed = JSON.parse(raw);
              return parsed?.[jsonKey] === val;
            } catch {
              return false;
            }
          }
          const parsedKey = `_${jsonCol}_parsed` as keyof DbRow;
          const parsedObj = row[parsedKey] as Record<string, unknown> | undefined;
          return parsedObj?.[jsonKey] === val;
        }

        const rowVal = row[col];
        if (rowVal === undefined) return false;

        // Check if this is an ilike filter
        if (val && typeof val === "object" && val !== null && "type" in val && val.type === "ilike") {
          const pattern = (val as unknown as { pattern: string }).pattern;
          // Convert SQL ILIKE pattern to regex
          // % matches any sequence of characters, _ matches single character
          const regexPattern = pattern
            .replace(/%/g, ".*")
            .replace(/_/g, ".");
          const regex = new RegExp(`^${regexPattern}$`, "i");
          return typeof rowVal === "string" && regex.test(rowVal);
        }

        return row[col] === val;
      });
    }

    for (const { col, vals } of this.inFilters) {
      result = result.filter((row) => vals.includes(row[col]));
    }

    if (this.orderCols.length > 0) {
      result.sort((a, b) => {
        for (const { col, asc } of this.orderCols) {
          const aVal = a[col] as string;
          const bVal = b[col] as string;
          const comparison = new Date(aVal).getTime() - new Date(bVal).getTime();
          if (comparison !== 0) {
            return asc ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

    if (this.limitN !== null) {
      result = result.slice(0, this.limitN);
    }

    return result;
  }

  private _project(row: DbRow): DbRow {
    if (this.selectedColumns === "*") return { ...row };
    // Handle join syntax (e.g., "*, major_understandings(...)") by returning the row as-is
    if (this.selectedColumns.includes("major_understandings") || this.selectedColumns.includes("(")) {
      return { ...row };
    }
    const cols = this.selectedColumns.split(",").map((c) => c.trim());
    const result: DbRow = {};
    for (const col of cols) {
      if (col in row) result[col] = row[col];
    }
    return result;
  }
}

export class MockSupabaseClient {
  private tables: Map<string, DbRow[]> = new Map();
  private inserted: Array<{ table: string; row: DbRow }> = [];
  private updated: Array<{ table: string; id: string; data: DbRow }> = [];

  // Failure injection properties
  shouldFailNext: boolean = false;
  failMessage: string = "Mock failure";
  shouldFailOnTable: string | null = null;
  tableFailMessage: string = "Mock failure";

  constructor() {
    this.tables.set("resources", []);
    this.tables.set("verification_records", []);
    this.tables.set("resource_mappings", []);
    this.tables.set("domain_scores", []);
    this.tables.set("curriculum_sources", []);
    this.tables.set("curricula", []);
    this.tables.set("nodes", []);
    this.tables.set("major_understandings", []);
  }

  // Auth mock for testing routes that use authentication
  auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user-id", email: "test@example.com" } }, error: null }),
  };

  from(tableName: string): MockQueryBuilder {
    return new MockQueryBuilder(this.tables, tableName, this);
  }

  insert(tableName: string, row: DbRow): DbRow {
    // Check for failure injection
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error(this.failMessage);
    }
    if (this.shouldFailOnTable === tableName) {
      this.shouldFailOnTable = null;
      throw new Error(this.tableFailMessage);
    }

    const table = this.tables.get(tableName) ?? [];
    const newRow: DbRow = { ...row, id: row.id ?? `mock-${table.length + 1}` };
    if (!newRow.created_at) newRow.created_at = new Date().toISOString();
    table.push(newRow);
    this.tables.set(tableName, table);
    this.inserted.push({ table: tableName, row: newRow });
    return newRow;
  }

  deleteFromTable(tableName: string): Promise<void> {
    const table = this.tables.get(tableName) ?? [];
    table.length = 0;
    return Promise.resolve();
  }

  insertMultiple(tableName: string, rows: DbRow[]): { data: DbRow[]; error: null } {
    const inserted = rows.map((r) => this.insert(tableName, r));
    return { data: inserted, error: null };
  }

  update(tableName: string, data: DbRow, eqCol: string, eqVal: unknown): { data: DbRow[] | null; error: Error | null } {
    const table = this.tables.get(tableName) ?? [];
    let count = 0;
    for (const row of table) {
      if (row[eqCol] === eqVal) {
        Object.assign(row, data);
        this.updated.push({ table: tableName, id: row.id as string, data });
        count++;
      }
    }
    return { data: count > 0 ? table.filter((r) => r[eqCol] === eqVal) : null, error: null };
  }

  getRows(tableName: string): DbRow[] {
    return this.tables.get(tableName) ?? [];
  }

  getInserted(tableName: string): DbRow[] {
    return this.inserted.filter((i) => i.table === tableName).map((i) => i.row);
  }

  getUpdated(tableName: string): Array<{ id: string; data: DbRow }> {
    return this.updated.filter((u) => u.table === tableName);
  }

  reset() {
    for (const key of this.tables.keys()) {
      this.tables.set(key, []);
    }
    this.inserted = [];
    this.updated = [];
  }
}

// --- Test fixture builders ---

import type { AcquiredPage } from "@/lib/acquisition/types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";
import type { VerificationResult } from "@/lib/verification/types";
import type { PersistenceInput } from "@/lib/persistence/types";

function makeCanonicalUrl(url: string): { url: string; parsed: URL; original: string } {
  return { url, parsed: new URL(url), original: url };
}

export function makeAcquiredPage(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  return {
    finalUrl: "https://example.com/page",
    canonicalUrl: makeCanonicalUrl("https://example.com/page") as AcquiredPage["canonicalUrl"],
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<html><body>Content</body></html>",
    contentType: "text/html",
    charset: "utf-8",
    contentHash: "abc123hash",
    acquiredAt: new Date().toISOString(),
    redirectChain: [],
    resolvedIps: { ipv4: [], ipv6: [] },
    ...overrides,
  };
}

export function makeStructuredContent(overrides: Partial<StructuredContent> = {}): StructuredContent {
  return {
    source: { cleanedHash: "cleaned-hash-abc", contentHash: "abc123hash" },
    metadata: { title: "Test Resource", description: null, author: null, datePublished: null, language: null },
    headings: [{ level: 1, text: "Test Resource" }],
    blocks: [{ text: "Test content here", tagName: "p" }],
    links: [],
    statistics: {
      wordCount: 2, headingCount: 1,
      headingCountsByLevel: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      paragraphCount: 1, linkCount: 0, externalLinkCount: 0,
    },
    ...overrides,
  };
}

export function makeEducationalEvidence(overrides: Partial<EducationalEvidence> = {}): EducationalEvidence {
  return {
    source: { cleanedHash: "cleaned-hash-abc", contentHash: "abc123hash" },
    interpreted: { explicitLearningObjectives: [], explicitDefinitions: [], explicitExercises: [] },
    ...overrides,
  };
}

export function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    status: "verified", deterministicChecks: { cleanedContentNonEmpty: true },
    advisorySignals: { titlePresent: true, educationalEvidencePresent: false, wordCount: 2, headingCount: 1, paragraphCount: 1 },
    contentHash: "abc123hash", canonicalUrl: "https://example.com/page",
    verifiedAt: new Date().toISOString(), ...overrides,
  };
}

export function makePersistenceInput(overrides: Partial<PersistenceInput> = {}): PersistenceInput {
  return {
    acquiredPage: makeAcquiredPage(), structuredContent: makeStructuredContent(),
    educationalEvidence: makeEducationalEvidence(), verificationResult: makeVerificationResult(),
    target: { nodeId: "node-123" }, acquisitionJobId: "job-123",
    callerMetadata: { resourceType: "text", licenseStatus: "link_only", aiNote: "Test note" },
    ...overrides,
  };
}