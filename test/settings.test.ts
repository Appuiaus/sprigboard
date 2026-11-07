import { describe, expect, it } from "vitest";
import { fillTemplate, jobStatuses, parseSetting, SETTINGS, withDefaults } from "../src/settings";
import { invoiceTotals, localTime, matchSymbol, percentLabel, todayIn } from "../src/lib";

const def = (key: string) => SETTINGS.find((d) => d.key === key)!;

describe("settings registry", () => {
  it("has unique keys and valid sections", () => {
    const keys = SETTINGS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("fills defaults under stored values", () => {
    const st = withDefaults({ gst_rate: "12.5" });
    expect(st.gst_rate).toBe("12.5");
    expect(st.timezone).toBe("Australia/Brisbane");
    expect(st.show_onboarding).toBe("1");
  });
  it("validates numbers, selects, emails and status names", () => {
    expect(parseSetting(def("gst_rate"), "12.5")).toEqual({ value: "12.5" });
    expect(parseSetting(def("gst_rate"), "150")).toEqual({ error: expect.stringContaining("0 to 100") });
    expect(parseSetting(def("job_pad"), "3.5")).toEqual({ error: expect.stringContaining("whole number") });
    expect(parseSetting(def("timezone"), "Mars/Base")).toEqual({ error: expect.any(String) });
    expect(parseSetting(def("timezone"), "Australia/Perth")).toEqual({ value: "Australia/Perth" });
    expect(parseSetting(def("email"), "nope")).toEqual({ error: expect.stringContaining("valid email") });
    expect(parseSetting(def("status_label_sent"), " ")).toEqual({ error: expect.stringContaining("Sent to client") });
    expect(parseSetting(def("match_genus"), null)).toEqual({ value: "0" });
    expect(parseSetting(def("match_genus"), "1")).toEqual({ value: "1" });
  });
  it("renames job statuses", () => {
    expect(jobStatuses(withDefaults({ status_label_sent: "With Shane" }))[2]).toEqual(["sent", "With Shane"]);
  });
});

describe("templates", () => {
  it("fills placeholders and tidies empty ones", () => {
    const t = "Presentation drawing {job}, {project}, {address} ({size})";
    expect(fillTemplate(t, { job: "J-0001", project: "Nguyen", address: "12 Smith St", size: "Medium" }, true)).toBe("Presentation drawing J-0001, Nguyen, 12 Smith St (Medium)");
    expect(fillTemplate(t, { job: "J-0001", project: "", address: "", size: "" }, true)).toBe("Presentation drawing J-0001");
    expect(fillTemplate(t, { job: "J-0001", project: "", address: "12 Smith St", size: "" }, true)).toBe("Presentation drawing J-0001, 12 Smith St");
  });
  it("leaves unknown placeholders and keeps line breaks in messages", () => {
    expect(fillTemplate("Hi {contact},\n\n{oops}", { contact: "Shane" })).toBe("Hi Shane,\n\n{oops}");
  });
});

describe("configurable maths and places", () => {
  it("uses the GST rate", () => {
    const lines = [{ description: "x", qty: 1, unit_cents: 30000 }];
    expect(invoiceTotals(lines, true, 10).total_cents).toBe(33000);
    expect(invoiceTotals(lines, true, 12.5).gst_cents).toBe(3750);
    expect(invoiceTotals(lines, false, 12.5).gst_cents).toBe(0);
    expect(percentLabel(12.5)).toBe("12.5%");
  });
  it("uses the time zone", () => {
    const now = new Date("2026-11-06T14:30:00Z");
    expect(todayIn("Australia/Brisbane", now)).toBe("2026-11-07");
    expect(todayIn("Australia/Perth", now)).toBe("2026-11-06");
    expect(todayIn("Not/AZone", now)).toBe("2026-11-07");
    expect(localTime("2026-11-07 04:05:00", "Australia/Perth")).toMatch(/12:05\s?pm/i);
  });
  it("can turn off species and genus matching", () => {
    const syms = [{ id: 1, botanical: "Westringia fruticosa", common: "", code: "" }];
    expect(matchSymbol("Westringia fruticosa 'Grey Box'", syms)).toMatchObject({ how: "species" });
    expect(matchSymbol("Westringia fruticosa 'Grey Box'", syms, { species: false, genus: false })).toBeNull();
    expect(matchSymbol("Westringia longifolia", syms, { genus: false })).toBeNull();
  });
});
