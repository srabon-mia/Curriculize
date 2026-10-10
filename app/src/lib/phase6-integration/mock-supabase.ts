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
  private orderCol: string | null = null;
  private orderAsc: boolean = true;
  private limitN: number | null = null;
  private insertData: DbRow | null = null;
  private lastInsertId: string | null = null;
  private isUpdateChain: boolean = false;

  constructor(tables: Map<string, DbRow[]>, tableName: string) {
    this.tables = tables;
    this.tableName = tableName;
  }

  private getTableRows(): DbRow[] {
    return this.tables.get(this.tableName) ?? [];
  }

  insert(data: DbRow): this {
    this.isUpdateChain = false;
    // Assign an ID if not present
    const rowToInsert = { ...data, id: data.id ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` };
    this.insertData = rowToInsert;
    this.lastInsertId = rowToInsert.id as string;
    const table = this.getTableRows();
    table.push(rowToInsert);
    this.tables.set(this.tableName, table);
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

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  // No-op at runtime, exists for type compatibility with Supabase PostgrestBuilder
  // Returns a new builder with the specified row type for type-safe chaining
  returns<TNewRow extends RowShape>(): MockQueryBuilder<TNewRow> {
    return this as unknown as MockQueryBuilder<TNewRow>;
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
        ? { data: this._project({ ...filtered[0], ...this.insertData }) as TRow, error: null }
        : { data: null, error: null };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: return the newly inserted row only
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: this._project({ ...row }) as TRow, error: null };
      }
      this._resetChain();
      return { data: null, error: null };
    }
    const results = this._filter();
    if (results.length === 0) return { data: null, error: null };
    return { data: this._project(results[0]) as TRow, error: null };
  }

  single(): { data: TRow | null; error: Error | null } {
    if (this.isUpdateChain && this.insertData) {
      // Update chain: apply to all matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        Object.assign(row, this.insertData);
      }
      const result = filtered[0]
        ? { data: this._project({ ...filtered[0], ...this.insertData }) as TRow, error: null }
        : { data: null, error: new Error("No rows found") };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: return the newly inserted row only
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: this._project({ ...row }) as TRow, error: null };
      }
      this._resetChain();
      return { data: null, error: new Error("No rows found") };
    }
    const results = this._filter();
    if (results.length === 0) return { data: null, error: new Error("No rows found") };
    if (results.length > 1) return { data: null, error: new Error("Multiple rows") };
    return { data: this._project(results[0]) as TRow, error: null };
  }

  execute(): { data: TRow[]; error: Error | null } {
    if (this.isUpdateChain && this.insertData) {
      // Update chain: apply to all matching rows
      const filtered = this._filter();
      for (const row of filtered) {
        Object.assign(row, this.insertData);
      }
      const result = { data: filtered.map((r) => this._project({ ...r, ...this.insertData! })) as TRow[], error: null };
      this._resetChain();
      return result;
    }
    if (this.insertData && this.lastInsertId) {
      // Insert chain: return the newly inserted row only
      const table = this.getTableRows();
      const row = table.find(r => r.id === this.lastInsertId);
      if (row) {
        this._resetChain();
        return { data: [this._project({ ...row }) as TRow], error: null };
      }
      this._resetChain();
      return { data: [], error: null };
    }
    return { data: this._filter().map((r) => this._project(r) as TRow), error: null };
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
        return row[col] === val;
      });
    }

    for (const { col, vals } of this.inFilters) {
      result = result.filter((row) => vals.includes(row[col]));
    }

    if (this.orderCol) {
      result.sort((a, b) => {
        const aVal = a[this.orderCol!] as string;
        const bVal = b[this.orderCol!] as string;
        return this.orderAsc
          ? new Date(aVal).getTime() - new Date(bVal).getTime()
          : new Date(bVal).getTime() - new Date(aVal).getTime();
      });
    }

    if (this.limitN !== null) {
      result = result.slice(0, this.limitN);
    }

    return result;
  }

  private _project(row: DbRow): DbRow {
    if (this.selectedColumns === "*") return { ...row };
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

  constructor() {
    this.tables.set("resources", []);
    this.tables.set("verification_records", []);
    this.tables.set("resource_mappings", []);
    this.tables.set("domain_scores", []);
  }

  from(tableName: string): MockQueryBuilder {
    return new MockQueryBuilder(this.tables, tableName);
  }

  insert(tableName: string, row: DbRow): DbRow {
    const table = this.tables.get(tableName) ?? [];
    const newRow: DbRow = { ...row, id: row.id ?? `mock-${table.length + 1}` };
    if (!newRow.created_at) newRow.created_at = new Date().toISOString();
    table.push(newRow);
    this.tables.set(tableName, table);
    this.inserted.push({ table: tableName, row: newRow });
    return newRow;
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