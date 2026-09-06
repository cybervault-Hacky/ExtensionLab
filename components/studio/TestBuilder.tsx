"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/**
 * Test Automation Studio builder (Phase 15, §5–§11).
 *
 * Builds a saved-test definition purely from the Phase 4 allowlist — the UI
 * can only emit action types with their bounded fields, so there is nothing
 * to escape: no JS, no shell, no raw selectors. The definition is re-validated
 * server-side on save and again at execution time.
 *
 * Accessibility: every control is a labelled form element; reordering works
 * with keyboard Move up/Move down buttons in addition to drag-and-drop; focus
 * stays visible; no motion-dependent affordances.
 */

/** Shared form control styling from the existing design system. */
const INPUT_CLASS =
  "min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]";
const INPUT_CLASS_SM = `${INPUT_CLASS} min-h-[36px] text-xs`;

export const STUDIO_ACTION_TYPES: ReadonlyArray<{ type: string; label: string; needs: readonly string[] }> = [
  { type: "open_url", label: "Open URL", needs: ["url"] },
  { type: "reload_page", label: "Reload page", needs: [] },
  { type: "wait", label: "Wait", needs: ["milliseconds"] },
  { type: "click", label: "Click element", needs: ["selector"] },
  { type: "type", label: "Type text", needs: ["selector", "value"] },
  { type: "select", label: "Select option", needs: ["selector", "value"] },
  { type: "scroll", label: "Scroll", needs: ["selector"] },
  { type: "inspect_text", label: "Inspect text", needs: ["selector"] },
  { type: "inspect_element", label: "Inspect element", needs: ["selector"] },
  { type: "open_popup", label: "Open popup", needs: [] },
  { type: "clear_console", label: "Clear console", needs: [] },
  { type: "capture_screenshot", label: "Capture screenshot", needs: [] },
];

export const STUDIO_ASSERTION_TYPES: ReadonlyArray<{ type: string; label: string; needs: readonly string[] }> = [
  { type: "extension_loaded", label: "Extension loaded", needs: [] },
  { type: "service_worker_detected", label: "Service worker detected", needs: [] },
  { type: "content_script_detected", label: "Content script detected", needs: [] },
  { type: "popup_available", label: "Popup available", needs: [] },
  { type: "element_exists", label: "Element exists", needs: ["selector"] },
  { type: "element_visible", label: "Element visible", needs: ["selector"] },
  { type: "text_contains", label: "Text contains", needs: ["selector", "value"] },
  { type: "url_equals", label: "URL equals", needs: ["value"] },
  { type: "url_contains", label: "URL contains", needs: ["value"] },
  { type: "console_contains", label: "Console contains", needs: ["value"] },
  { type: "console_not_contains", label: "Console does not contain", needs: ["value"] },
  { type: "network_request_seen", label: "Network request seen", needs: ["value"] },
  { type: "network_status_equals", label: "Request status equals", needs: ["value", "expectedStatus"] },
  { type: "network_4xx_none", label: "No 4xx responses", needs: [] },
  { type: "network_5xx_none", label: "No 5xx responses", needs: [] },
  { type: "runtime_error_none", label: "No runtime errors", needs: [] },
];

export interface StudioStep {
  type: string;
  selector?: string;
  value?: string;
  url?: string;
  milliseconds?: number;
  description?: string;
}

export interface StudioAssertion {
  type: string;
  selector?: string;
  value?: string;
  expectedStatus?: number;
  message?: string;
}

export interface StudioVariable {
  name: string;
  type: "text" | "number" | "url" | "boolean";
  required?: boolean;
  maxLength?: number;
  defaultValue?: string;
}

export interface StudioDefinitionDraft {
  schemaVersion: 1;
  setup: StudioStep[];
  actions: StudioStep[];
  assertions: StudioAssertion[];
  cleanup: StudioStep[];
  variables: StudioVariable[];
  timeoutMs: number;
  category: string;
  severity: string;
}

export const PREDEFINED_VARIABLES = ["extension_name", "browser", "test_url", "package_version"] as const;

const emptyDefinition = (): StudioDefinitionDraft => ({
  schemaVersion: 1,
  setup: [],
  actions: [],
  assertions: [],
  cleanup: [],
  variables: [],
  timeoutMs: 15000,
  category: "loading",
  severity: "medium",
});

/** Selector assistant (§10): builds a safe selector from explicit strategy
 * inputs. Strategies match the server validator exactly — nth-child and deep
 * paths cannot be produced at all. */
export function buildSelector(strategy: "id" | "testid" | "role" | "attribute", value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (strategy === "id") return /^-?[A-Za-z][\w-]*$/.test(trimmed) ? `#${trimmed}` : null;
  if (strategy === "testid") return /^[\w.-]{1,100}$/.test(trimmed) ? `[data-testid="${trimmed}"]` : null;
  if (strategy === "role") return trimmed === "button" || trimmed === "a" ? trimmed : null; // stable tag fallback
  return /^[\w-]+=\S+$/.test(trimmed) ? `[${trimmed.replaceAll('"', "")}]` : null;
}

interface StepListProps {
  title: string;
  hint: string;
  steps: StudioStep[];
  onChange: (steps: StudioStep[]) => void;
  /** Hide types that make no sense in setup/cleanup (popup/console). */
  allowed?: readonly string[];
}

function StepList({ title, hint, steps, onChange, allowed }: StepListProps) {
  const dragIndex = useRef<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  const update = (index: number, patch: Partial<StudioStep>) => {
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };
  const types = STUDIO_ACTION_TYPES.filter((action) => !allowed || allowed.includes(action.type));

  return (
    <section aria-label={title} className="border border-[var(--border)] rounded-lg p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">{hint}</p>
      <div className="mt-3 space-y-3">
        {steps.length === 0 ? (
          <p className="text-xs text-[var(--text-secondary)]">No steps yet.</p>
        ) : (
          <ol className="space-y-2">
            {steps.map((step, index) => {
              const meta = STUDIO_ACTION_TYPES.find((action) => action.type === step.type);
              return (
                <li
                  key={`${step.type}-${index}`}
                  className="border border-[var(--border)] rounded-md p-3"
                  draggable
                  onDragStart={() => {
                    dragIndex.current = index;
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex.current !== null) move(dragIndex.current, index);
                    dragIndex.current = null;
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[var(--text-secondary)]" aria-hidden>
                      {index + 1}.
                    </span>
                    <label className="sr-only" htmlFor={`step-${title}-${index}-type`}>
                      {`${title} step ${index + 1} type`}
                    </label>
                    <select
                      id={`step-${title}-${index}-type`}
                      className={INPUT_CLASS_SM}
                      value={step.type}
                      onChange={(event) => update(index, { type: event.target.value })}
                    >
                      {types.map((action) => (
                        <option key={action.type} value={action.type}>
                          {action.label}
                        </option>
                      ))}
                    </select>
                    <div className="ml-auto flex items-center gap-1" role="group" aria-label={`Move ${title} step ${index + 1}`}>
                      <Button variant="ghost" size="sm" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move step ${index + 1} up`}>
                        Move up
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => move(index, index + 1)} disabled={index === steps.length - 1} aria-label={`Move step ${index + 1} down`}>
                        Move down
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onChange(steps.filter((_, i) => i !== index))} aria-label={`Remove step ${index + 1}`}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {meta?.needs.includes("selector") && (
                      <div>
                        <label className="text-xs" htmlFor={`step-${title}-${index}-selector`}>
                          Selector
                        </label>
                        <input
                          id={`step-${title}-${index}-selector`}
                          className={INPUT_CLASS_SM}
                          value={step.selector ?? ""}
                          placeholder="#id, .class, tag or [data-testid=&quot;x&quot;]"
                          onChange={(event) => update(index, { selector: event.target.value })}
                        />
                      </div>
                    )}
                    {meta?.needs.includes("value") && (
                      <div>
                        <label className="text-xs" htmlFor={`step-${title}-${index}-value`}>
                          Value
                        </label>
                        <input
                          id={`step-${title}-${index}-value`}
                          className={INPUT_CLASS_SM}
                          value={step.value ?? ""}
                          onChange={(event) => update(index, { value: event.target.value })}
                        />
                      </div>
                    )}
                    {meta?.needs.includes("url") && (
                      <div>
                        <label className="text-xs" htmlFor={`step-${title}-${index}-url`}>
                          URL
                        </label>
                        <input
                          id={`step-${title}-${index}-url`}
                          className={INPUT_CLASS_SM}
                          value={step.url ?? ""}
                          placeholder="https://example.com or {{test_url}}"
                          onChange={(event) => update(index, { url: event.target.value })}
                        />
                      </div>
                    )}
                    {meta?.needs.includes("milliseconds") && (
                      <div>
                        <label className="text-xs" htmlFor={`step-${title}-${index}-ms`}>
                          Milliseconds (0–5000)
                        </label>
                        <input
                          id={`step-${title}-${index}-ms`}
                          className={INPUT_CLASS_SM}
                          type="number"
                          min={0}
                          max={5000}
                          value={step.milliseconds ?? 500}
                          onChange={(event) => update(index, { milliseconds: Number(event.target.value) })}
                        />
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <label className="text-xs" htmlFor={`step-${title}-${index}-note`}>
                        Note (optional, never executed)
                      </label>
                      <input
                        id={`step-${title}-${index}-note`}
                        className={INPUT_CLASS_SM}
                        value={step.description ?? ""}
                        onChange={(event) => update(index, { description: event.target.value })}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange([...steps, allowed && !allowed.includes("open_url") ? { type: allowed[0] } : { type: "open_url", url: "{{test_url}}" }])
          }
        >
          Add step
        </Button>
      </div>
    </section>
  );
}

export interface TestBuilderProps {
  initial?: {
    id?: string;
    name: string;
    description: string;
    tags: string[];
    browsers: string[];
    definition: StudioDefinitionDraft;
    status?: string;
    version?: number;
    packageId?: string;
  };
  packages: Array<{ id: string; name: string; version: string | null }>;
  templates: Array<{ id: string; name: string; description: string; definition: StudioDefinitionDraft | null }>;
  onSaved: () => void;
  onCancel: () => void;
}

export function TestBuilder({ initial, packages, templates, onSaved, onCancel }: TestBuilderProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [browsers, setBrowsers] = useState<string[]>(initial?.browsers ?? ["chromium"]);
  const [definition, setDefinition] = useState<StudioDefinitionDraft>(initial?.definition ?? emptyDefinition());
  const [packageId, setPackageId] = useState(initial?.packageId ?? packages[0]?.id ?? "");
  const [selectorHelperValue, setSelectorHelperValue] = useState("");
  const [selectorPreview, setSelectorPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patchDefinition = useCallback((patch: Partial<StudioDefinitionDraft>) => {
    setDefinition((current) => ({ ...current, ...patch }));
  }, []);

  const toggleBrowser = (browser: string) => {
    setBrowsers((current) => (current.includes(browser) ? current.filter((item) => item !== browser) : [...current, browser]));
  };

  const save = async (status: "DRAFT" | "ACTIVE") => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        description,
        tags: tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
        browsers,
        definition,
      };
      const response = await fetch(initial?.id ? `/api/tests/saved/${initial.id}` : "/api/tests/saved", {
        method: initial?.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          initial?.id
            ? { ...payload, status: initial.status === "ARCHIVED" ? undefined : status, expectedVersion: initial.version }
            : { ...payload, packageId },
        ),
      });
      const body = (await response.json()) as { error?: string; message?: string; test?: { id?: string } };
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Saving failed.");
      // A newly created test starts as DRAFT; activate on demand.
      if (!initial?.id && status === "ACTIVE" && typeof body.test?.id === "string") {
        const activate = await fetch(`/api/tests/saved/${body.test.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "ACTIVE" }),
        });
        if (!activate.ok) {
          const activateBody = (await activate.json()) as { message?: string };
          throw new Error(activateBody.message ?? "Saved as draft; activation failed.");
        }
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-sm" htmlFor="studio-name">
            Test name
          </label>
          <input id="studio-name" className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </div>
        <div>
          <label className="text-sm" htmlFor="studio-package">
            Extension package (execution binds to its exact bytes)
          </label>
          <select id="studio-package" className={INPUT_CLASS} value={packageId} onChange={(event) => setPackageId(event.target.value)} disabled={Boolean(initial?.id)}>
            {packages.map((pkg) => (
              <option key={pkg.id} value={pkg.id}>
                {pkg.name}
                {pkg.version ? ` (${pkg.version})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="text-sm" htmlFor="studio-description">
            Description
          </label>
          <textarea
            id="studio-description"
            className={INPUT_CLASS}
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div>
          <label className="text-sm" htmlFor="studio-tags">
            Tags (comma separated, lowercase)
          </label>
          <input id="studio-tags" className={INPUT_CLASS} value={tags} onChange={(event) => setTags(event.target.value)} />
        </div>
        <fieldset>
          <legend className="text-sm">Browsers</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {["chromium", "edge", "firefox"].map((browser) => (
              <label key={browser} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={browsers.includes(browser)} onChange={() => toggleBrowser(browser)} />
                {browser.charAt(0).toUpperCase() + browser.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="text-sm" htmlFor="studio-timeout">
            Timeout (ms, 1000–120000)
          </label>
          <input
            id="studio-timeout"
            className={INPUT_CLASS}
            type="number"
            min={1000}
            max={120000}
            step={500}
            value={definition.timeoutMs}
            onChange={(event) => patchDefinition({ timeoutMs: Number(event.target.value) })}
          />
        </div>
        <div>
          <label className="text-sm" htmlFor="studio-category">
            Category
          </label>
          <select id="studio-category" className={INPUT_CLASS} value={definition.category} onChange={(event) => patchDefinition({ category: event.target.value })}>
            {["loading", "popup", "content_script", "service_worker", "permissions", "console", "network", "performance", "page"].map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
      </div>

      <details className="border border-[var(--border)] rounded-lg p-3">
        <summary className="text-sm font-semibold cursor-pointer">Selector assistant</summary>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Build a safe selector from a stable strategy. The generator matches the server validator: stable id, data-testid, stable tag, or a single
          attribute. Positional (nth-child) and deep paths are impossible here by design.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label className="text-xs" htmlFor="selector-strategy">
              Strategy
            </label>
            <select
              id="selector-strategy"
              className={INPUT_CLASS_SM}
              onChange={(event) => setSelectorPreview(buildSelector(event.target.value as "id", selectorHelperValue))}
            >
              <option value="id">Stable element id</option>
              <option value="testid">data-testid</option>
              <option value="role">Stable tag (button, a)</option>
              <option value="attribute">Attribute (name=value)</option>
            </select>
          </div>
          <div>
            <label className="text-xs" htmlFor="selector-value">
              Value
            </label>
            <input id="selector-value" className={INPUT_CLASS_SM} value={selectorHelperValue} onChange={(event) => setSelectorHelperValue(event.target.value)} />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const strategySelect = document.getElementById("selector-strategy") as HTMLSelectElement | null;
              setSelectorPreview(buildSelector((strategySelect?.value ?? "id") as "id", selectorHelperValue));
            }}
          >
            Preview
          </Button>
          {selectorPreview !== null && <Badge tone="success">{selectorPreview}</Badge>}
          {selectorPreview === null && selectorHelperValue.trim() !== "" && <Badge tone="warning">Not a safe selector — adjust the value</Badge>}
        </div>
      </details>

      <StepList
        title="Setup"
        hint="Runs before the main actions in the same fresh browser. Allowlisted steps only."
        steps={definition.setup}
        onChange={(steps) => patchDefinition({ setup: steps })}
        allowed={["open_url", "wait", "clear_console"]}
      />
      <StepList title="Actions" hint="The test journey. Steps run in order in a fresh, isolated browser." steps={definition.actions} onChange={(steps) => patchDefinition({ actions: steps })} />

      <section aria-label="Assertions" className="border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-semibold">Assertions</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">Evaluated after all actions from captured runtime evidence.</p>
        <div className="mt-3 space-y-2">
          {definition.assertions.map((assertion, index) => {
            const meta = STUDIO_ASSERTION_TYPES.find((entry) => entry.type === assertion.type);
            return (
              <div key={`${assertion.type}-${index}`} className="border border-[var(--border)] rounded-md p-3 grid gap-2 sm:grid-cols-3">
                <div>
                  <label className="text-xs" htmlFor={`assertion-${index}-type`}>
                    Assertion {index + 1}
                  </label>
                  <select
                    id={`assertion-${index}-type`}
                    className={INPUT_CLASS_SM}
                    value={assertion.type}
                    onChange={(event) =>
                      patchDefinition({
                        assertions: definition.assertions.map((entry, i) => (i === index ? { ...entry, type: event.target.value } : entry)),
                      })
                    }
                  >
                    {STUDIO_ASSERTION_TYPES.map((entry) => (
                      <option key={entry.type} value={entry.type}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
                {meta?.needs.includes("selector") && (
                  <div>
                    <label className="text-xs" htmlFor={`assertion-${index}-selector`}>
                      Selector
                    </label>
                    <input
                      id={`assertion-${index}-selector`}
                      className={INPUT_CLASS_SM}
                      value={assertion.selector ?? ""}
                      onChange={(event) =>
                        patchDefinition({ assertions: definition.assertions.map((entry, i) => (i === index ? { ...entry, selector: event.target.value } : entry)) })
                      }
                    />
                  </div>
                )}
                {meta?.needs.includes("value") && (
                  <div>
                    <label className="text-xs" htmlFor={`assertion-${index}-value`}>
                      Value
                    </label>
                    <input
                      id={`assertion-${index}-value`}
                      className={INPUT_CLASS_SM}
                      value={assertion.value ?? ""}
                      onChange={(event) =>
                        patchDefinition({ assertions: definition.assertions.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)) })
                      }
                    />
                  </div>
                )}
                {meta?.needs.includes("expectedStatus") && (
                  <div>
                    <label className="text-xs" htmlFor={`assertion-${index}-status`}>
                      Expected status
                    </label>
                    <input
                      id={`assertion-${index}-status`}
                      className={INPUT_CLASS_SM}
                      type="number"
                      value={assertion.expectedStatus ?? 200}
                      onChange={(event) =>
                        patchDefinition({
                          assertions: definition.assertions.map((entry, i) => (i === index ? { ...entry, expectedStatus: Number(event.target.value) } : entry)),
                        })
                      }
                    />
                  </div>
                )}
                <div className="sm:col-span-3">
                  <Button variant="ghost" size="sm" onClick={() => patchDefinition({ assertions: definition.assertions.filter((_, i) => i !== index) })} aria-label={`Remove assertion ${index + 1}`}>
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
          <Button variant="secondary" size="sm" onClick={() => patchDefinition({ assertions: [...definition.assertions, { type: "extension_loaded" }] })}>
            Add assertion
          </Button>
        </div>
      </section>

      <StepList
        title="Cleanup"
        hint="Runs after assertions regardless of outcome; failures become warnings, never test failures."
        steps={definition.cleanup}
        onChange={(steps) => patchDefinition({ cleanup: steps })}
        allowed={["wait", "clear_console", "capture_screenshot"]}
      />

      <section aria-label="Variables" className="border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-semibold">Variables</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Referenced as {"{{name}}"} in values and URLs. Predefined: {PREDEFINED_VARIABLES.map((variable) => `{{${variable}}}`).join(", ")}. Variables are
          typed inputs resolved server-side by substitution — they are never evaluated as code. Secrets are intentionally not supported.
        </p>
        <div className="mt-3 space-y-2">
          {definition.variables.map((variable, index) => (
            <div key={`${variable.name}-${index}`} className="grid gap-2 sm:grid-cols-5 items-end border border-[var(--border)] rounded-md p-3">
              <div>
                <label className="text-xs" htmlFor={`variable-${index}-name`}>
                  Name
                </label>
                <input
                  id={`variable-${index}-name`}
                  className={INPUT_CLASS_SM}
                  value={variable.name}
                  onChange={(event) =>
                    patchDefinition({ variables: definition.variables.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)) })
                  }
                />
              </div>
              <div>
                <label className="text-xs" htmlFor={`variable-${index}-type`}>
                  Type
                </label>
                <select
                  id={`variable-${index}-type`}
                  className={INPUT_CLASS_SM}
                  value={variable.type}
                  onChange={(event) =>
                    patchDefinition({
                      variables: definition.variables.map((entry, i) => (i === index ? { ...entry, type: event.target.value as StudioVariable["type"] } : entry)),
                    })
                  }
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="url">url</option>
                  <option value="boolean">boolean</option>
                </select>
              </div>
              <div>
                <label className="text-xs" htmlFor={`variable-${index}-default`}>
                  Default (optional)
                </label>
                <input
                  id={`variable-${index}-default`}
                  className={INPUT_CLASS_SM}
                  value={variable.defaultValue ?? ""}
                  onChange={(event) =>
                    patchDefinition({ variables: definition.variables.map((entry, i) => (i === index ? { ...entry, defaultValue: event.target.value } : entry)) })
                  }
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={variable.required === true}
                  onChange={(event) =>
                    patchDefinition({ variables: definition.variables.map((entry, i) => (i === index ? { ...entry, required: event.target.checked } : entry)) })
                  }
                />
                Required
              </label>
              <Button variant="ghost" size="sm" onClick={() => patchDefinition({ variables: definition.variables.filter((_, i) => i !== index) })} aria-label={`Remove variable ${variable.name}`}>
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patchDefinition({ variables: [...definition.variables, { name: "", type: "text" }] })}
            disabled={definition.variables.length >= 10}
          >
            Add variable
          </Button>
        </div>
      </section>

      {!initial && templates.length > 0 && (
        <details className="border border-[var(--border)] rounded-lg p-3">
          <summary className="text-sm font-semibold cursor-pointer">Start from a built-in template</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {templates.map((template) => (
              <Button
                key={template.id}
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (!template.definition) return;
                  setName(template.name);
                  setDescription(template.description);
                  setDefinition(template.definition);
                }}
              >
                Use {template.name}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Using a template copies it into your draft — built-ins are never modified.</p>
        </details>
      )}

      {error && (
        <p role="alert" className="text-sm text-[var(--status-error)]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save("DRAFT")} disabled={saving || name.trim() === "" || packageId === ""}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={() => void save("ACTIVE")} disabled={saving || name.trim() === "" || packageId === ""}>
          Save and activate
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** Debounced search hook (§101 performance). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useMemoizedCount(items: string[]): number {
  return useMemo(() => items.length, [items]);
}
