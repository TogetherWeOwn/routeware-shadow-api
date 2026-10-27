import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Test-Author-owned oracle for the routeExamples test infrastructure.
 *
 * Run: npx vitest run --config test/routeExamplesParameters.acceptance.config.ts
 * Neighbors: npx vitest run test/routeExamples.test.ts test/openapiContract.test.ts
 *   test/openapiDocsContent.test.ts test/docsLinksCheck.test.ts --maxWorkers=2
 *
 * This is a declaration/checker change, not a selector implementation. There
 * are no SQL queries, seed writes, credentials, upstreams or D1 bindings here.
 * The regular workerd neighbors exercise the actual mounted document. This
 * Node harness feeds tiny synthetic documents into the REAL existing test
 * callbacks, so it can verify that the checker itself catches regressions.
 * It never substitutes a second implementation of the parameter checker.
 *
 * Test-module seam for the Builder: keep REMAINING_RESPONSES as the single
 * inventory, with `parameters: Array<{name: string; in: "query" | "path"}>`
 * on each expanded operation (including [] for parameterless operations), and
 * retain the two named test callbacks below. Totals derive from these records.
 * The harness exposes the inventory only in its in-memory evaluated copy.
 * ROUTE_EXAMPLES_CHECKER_FILE optionally selects a pinned checker for RED
 * verification; the default is the neighboring routeExamples.test.ts.
 */
const PARAMETER_TEST = "publishes schema-compatible examples for every query and path parameter";
const INVENTORY_TEST = "pins the complete operation inventory of the remaining route modules";
const LIST = "/api/v1/customer-snapshot";
const DETAIL = "/api/v1/customer-snapshot/{customerId}";

type ParameterRecord = { name: string; in: "query" | "path" };
type InventoryEntry = {
  path: string;
  method: string;
  mediaType: string;
  parameters: ParameterRecord[];
};
type Parameter = {
  name: string;
  in: string;
  schema?: { type: string; minimum?: number; maximum?: number; example?: unknown };
  example?: unknown;
};
type FixtureDoc = {
  paths: Record<string, Record<string, { tags: string[]; parameters: Parameter[] }>>;
};
type Callback = () => unknown | Promise<unknown>;

function fixture(extraNames = 0) {
  // These expectations are literal and independent of the mounted schema.
  const inventory: InventoryEntry[] = [
    {
      method: "get", path: LIST, mediaType: "application/json",
      parameters: [{ name: "limit", in: "query" }, { name: "fields", in: "query" }, { name: "includeTotal", in: "query" }],
    },
    {
      method: "get", path: DETAIL, mediaType: "application/json",
      parameters: [{ name: "customerId", in: "path" }, { name: "fields", in: "query" }],
    },
  ];
  const doc: FixtureDoc = {
    paths: {
      [LIST]: {
        get: {
          tags: ["customer-snapshot"],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 }, example: 2 },
            { name: "fields", in: "query", schema: { type: "string", example: "customerId" } },
            { name: "includeTotal", in: "query", schema: { type: "boolean" }, example: false },
          ],
        },
      },
      [DETAIL]: {
        get: {
          tags: ["customer-snapshot"],
          parameters: [
            { name: "customerId", in: "path", schema: { type: "integer", minimum: 1 }, example: 7 },
            { name: "fields", in: "query", schema: { type: "string" }, example: "customerId" },
          ],
        },
      },
    },
  };
  for (let index = 0; index < extraNames; index++) {
    const name = `fixtureSelector${index}`;
    inventory[0].parameters.push({ name, in: "query" });
    doc.paths[LIST].get.parameters.push({ name, in: "query", schema: { type: "integer" }, example: index });
  }
  return { inventory, doc };
}

/** Collect, rather than run, unrelated tests and hooks in the subject module. */
function loadChecker(doc: FixtureDoc, replacement?: InventoryEntry[]) {
  const callbacks = new Map<string, Callback>();
  const register = Object.assign(
    (name: string, callback: Callback) => { callbacks.set(name, callback); },
    { each: (_rows: unknown) => (_name: string, _callback: unknown) => {} },
  );
  const worker = {
    default: {
      fetch: async (url: string) => {
        expect(url).toBe("http://test.local/openapi.json");
        return Response.json(doc);
      },
    },
  };
  const subject = readFileSync(
    process.env.ROUTE_EXAMPLES_CHECKER_FILE ?? new URL("./routeExamples.test.ts", import.meta.url), "utf8",
  );
  const compiled = ts.transpileModule(subject, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as { inventory: InventoryEntry[] } };
  runInNewContext(
    `${compiled}\nmodule.exports.inventory = REMAINING_RESPONSES;`,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === "cloudflare:workers") return { exports: worker };
        if (name === "vitest") return {
          describe: (_name: string, body: () => void) => body(),
          it: register,
          expect,
          beforeEach: () => {},
          afterEach: () => {},
        };
        throw new Error(`Unexpected subject import: ${name}`);
      },
      // No process, filesystem, timers, credentials or network in this context.
      Response,
    },
    { timeout: 5_000, filename: "routeExamples.checker-under-test.cjs" },
  );
  const inventory = module.exports.inventory;
  if (replacement) {
    // Project records to names ONLY for an unfixed, names-only checker so old
    // controls still run and location mutations fail behaviorally, not because
    // of an undefined property. The real-inventory test below rejects that
    // legacy seam; corrected checkers receive only the new parameter records.
    const namesOnly = inventory.some((entry) => "parameterNames" in entry && !("parameters" in entry));
    const entries = structuredClone(replacement);
    if (namesOnly) for (const entry of entries) Object.defineProperty(entry, "parameterNames", {
      get: () => entry.parameters.map(({ name }) => name),
    });
    inventory.splice(0, inventory.length, ...entries);
  }
  function run(name: string) {
    const callback = callbacks.get(name);
    expect(callback, `retain checker callback: ${name}`).toBeTypeOf("function");
    return Promise.resolve().then(() => callback!());
  }
  return {
    inventory,
    parameters: () => run(PARAMETER_TEST),
    operations: () => run(INVENTORY_TEST),
  };
}

async function rejectsWithParameter(callback: Callback, path: string, name: string, location?: ParameterRecord["in"]) {
  let failure: unknown;
  try {
    await callback();
  } catch (error) {
    failure = error;
  }
  expect(failure, `checker must reject get ${path} ${location ?? ""} ${name}`).toBeDefined();
  const message = String(failure).toLowerCase();
  expect(message, "failure identifies operation").toContain(`get ${path}`.toLowerCase());
  expect(message, "failure identifies parameter").toContain(name.toLowerCase());
  if (location) expect(message, "failure identifies parameter location").toContain(location);
}

function sameNameFixture() {
  const { inventory, doc } = fixture();
  // OpenAPI identifies a parameter by (name, in), not name alone. Both are
  // legal here; the query location must NOT be inferred from the URL template.
  inventory[1].parameters.push({ name: "customerId", in: "query" });
  doc.paths[DETAIL].get.parameters.push({ name: "customerId", in: "query", schema: { type: "integer" }, example: 8 });
  return { inventory, doc };
}

describe("routeExamples per-operation parameter acceptance", () => {
  it("keeps explicit name/location records beside every real operation, including empty records", () => {
    const { doc } = fixture();
    const { inventory } = loadChecker(doc);
    expect(inventory.length).toBeGreaterThan(0);
    for (const entry of inventory) {
      expect(Array.isArray(entry.parameters), `${entry.method} ${entry.path} parameters`).toBe(true);
      for (const parameter of entry.parameters) {
        expect(typeof parameter.name).toBe("string");
        expect(parameter.name.length).toBeGreaterThan(0);
        expect(["query", "path"]).toContain(parameter.in);
      }
      const identities = entry.parameters.map(({ name, in: location }) => JSON.stringify([name, location]));
      expect(new Set(identities).size).toBe(entry.parameters.length);
    }
  });

  it("accepts a matching five-parameter fixture, including false and schema-level examples", async () => {
    const { inventory, doc } = fixture();
    await loadChecker(doc, inventory).parameters();
  });

  it.each([
    [LIST, "limit", "query", "path"],
    [DETAIL, "customerId", "path", "query"],
  ] as const)("rejects a location-only remount: %s %s %s -> %s", async (path, name, from, to) => {
    const { inventory, doc } = fixture();
    doc.paths[path].get.parameters.find((p) => p.name === name && p.in === from)!.in = to;
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, path, name, from);
  });

  it("accepts a valid same-name query and path pair", async () => {
    const { inventory, doc } = sameNameFixture();
    await loadChecker(doc, inventory).parameters();
  });

  it.each(["query", "path"] as const)("rejects removing the %s member of a same-name pair", async (location) => {
    const { inventory, doc } = sameNameFixture();
    // Prove the fixture is valid before removing exactly one identity.
    await loadChecker(doc, inventory).parameters();
    doc.paths[DETAIL].get.parameters = doc.paths[DETAIL].get.parameters.filter(
      (p) => !(p.name === "customerId" && p.in === location),
    );
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, DETAIL, "customerId", location);
  });

  it("rejects swapping locations between distinct names at constant count", async () => {
    const { inventory, doc } = fixture();
    doc.paths[DETAIL].get.parameters.find((p) => p.name === "customerId")!.in = "query";
    doc.paths[DETAIL].get.parameters.find((p) => p.name === "fields")!.in = "path";
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, DETAIL, "customerId", "path");
  });

  it.each([
    [LIST, "limit"],
    [DETAIL, "customerId"],
    [DETAIL, "fields"],
  ])("names the operation and missing parameter %s %s", async (path, name) => {
    const { inventory, doc } = fixture();
    doc.paths[path].get.parameters = doc.paths[path].get.parameters.filter((p) => p.name !== name);
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, path, name);
  });

  it("names an unexpected mounted query parameter", async () => {
    const { inventory, doc } = fixture();
    doc.paths[LIST].get.parameters.push({ name: "unexpectedSelector", in: "query", schema: { type: "string" }, example: "x" });
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, LIST, "unexpectedSelector");
  });

  it("accepts a larger matching fixture that also satisfies the old global total", async () => {
    // Five named fixtures plus 70 inert selectors: this fixed test input also
    // passes the original 75-counter. The next two mutations therefore prove
    // silent false negatives, not merely a small-fixture/count mismatch.
    const { inventory, doc } = fixture(70);
    await loadChecker(doc, inventory).parameters();
  });

  it("detects a rename even though the global count is unchanged", async () => {
    const { inventory, doc } = fixture(70);
    doc.paths[LIST].get.parameters[0].name = "take";
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, LIST, "limit");
  });

  it("detects a selector moved to another operation even though names and global count are unchanged", async () => {
    const { inventory, doc } = fixture(70);
    const [moved] = doc.paths[LIST].get.parameters.splice(2, 1);
    doc.paths[DETAIL].get.parameters.push(moved);
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, LIST, "includeTotal");
  });

  it("does not mistake a header for a mounted query/path parameter", async () => {
    const { inventory, doc } = fixture();
    doc.paths[LIST].get.parameters[0].in = "header";
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, LIST, "limit");
  });

  it("ignores unrelated header parameters", async () => {
    const { inventory, doc } = fixture();
    doc.paths[LIST].get.parameters.push({ name: "X-Request-Id", in: "header" });
    await loadChecker(doc, inventory).parameters();
  });

  it.each([
    [LIST, "limit"], [LIST, "fields"], [LIST, "includeTotal"],
    [DETAIL, "customerId"], [DETAIL, "fields"],
  ])("still rejects a missing example for %s %s", async (path, name) => {
    const { inventory, doc } = fixture();
    const parameter = doc.paths[path].get.parameters.find((p) => p.name === name)!;
    delete parameter.example;
    delete parameter.schema!.example;
    await rejectsWithParameter(loadChecker(doc, inventory).parameters, path, name);
  });

  it.each([
    ["wrong integer type", "2"], ["below minimum", 0], ["above maximum", 201],
  ])("retains schema-conformity detection: %s", async (_name, value) => {
    const { inventory, doc } = fixture();
    doc.paths[LIST].get.parameters[0].example = value;
    await expect(loadChecker(doc, inventory).parameters()).rejects.toThrow("limit");
  });

  it.each(["list only", "detail only", "parameterless operation"])(
    "derives the checked total from the fixture records: %s",
    async (selection) => {
      const { inventory, doc } = fixture();
      if (selection === "list only") inventory.splice(1, 1);
      else if (selection === "detail only") inventory.splice(0, 1);
      else {
        inventory.splice(1, 1);
        inventory[0].parameters = [];
        doc.paths[LIST].get.parameters = [];
      }
      // Respectively 3, 2 and 0. No shared total or historical count ledger
      // is adjusted: only the independent per-operation fixture is changed.
      await loadChecker(doc, inventory).parameters();
    },
  );

  it("adding a selector edits exactly one record and no shared total", async () => {
    const { inventory, doc } = fixture();
    const checker = loadChecker(doc, inventory);
    const otherOperation = structuredClone(checker.inventory[1]);
    checker.inventory[0].parameters.push({ name: "regionId", in: "query" });
    doc.paths[LIST].get.parameters.push({ name: "regionId", in: "query", schema: { type: "integer" }, example: 9 });
    await checker.parameters();
    expect(checker.inventory[1]).toEqual(otherOperation);
    // The newly added selector must also be covered by the example walker.
    delete doc.paths[LIST].get.parameters.at(-1)!.example;
    await rejectsWithParameter(checker.parameters, LIST, "regionId");
  });

  it("retains the complete-operation inventory assertion", async () => {
    const { inventory, doc } = fixture();
    await loadChecker(doc, inventory).operations();
    delete doc.paths[DETAIL];
    await expect(loadChecker(doc, inventory).operations()).rejects.toThrow();
  });

  it("rejects an extra operation even when it has no parameters", async () => {
    const { inventory, doc } = fixture();
    doc.paths["/api/v1/customer-snapshot/unpinned"] = {
      get: { tags: ["customer-snapshot"], parameters: [] },
    };
    await expect(loadChecker(doc, inventory).operations()).rejects.toThrow();
  });
});
