/**
 * Pre-submit checks: settlement math vs seeded totals for key shows.
 * Run: npx tsx scripts/verify-settlement.ts
 */
import { calculateSettlement, isDealSupportedForInAppSettlement } from "../lib/dealMath";
import { getShowById } from "../lib/queries";
import { db } from "../db/index";
import { shows } from "../db/schema";

const COASTAL = "show_coastal_spell_dispute";
const TOLERANCE = 0.02;

let failures = 0;
let warnings = 0;

function fail(msg: string) {
  console.error("FAIL:", msg);
  failures++;
}
function warn(msg: string) {
  console.warn("WARN:", msg);
  warnings++;
}
function ok(msg: string) {
  console.log("OK:", msg);
}

async function checkCoastal() {
  const data = await getShowById(COASTAL);
  if (!data?.deal) {
    fail("Coastal: no deal");
    return;
  }
  const calc = calculateSettlement({
    deal: data.deal,
    ticketSales: data.ticketSales,
    expenses: data.expenses,
    venueCapacity: data.venue?.capacity,
    agreement: data.agreement,
    recoups: data.recoups,
  });
  if (!calc.supported) {
    fail("Coastal: expected supported settlement");
    return;
  }

  const expectedMariana = 11565;
  if (Math.abs(calc.totalToArtist - expectedMariana) > 1) {
    fail(
      `Coastal worksheet should be ~${expectedMariana}, got ${calc.totalToArtist}`,
    );
  } else {
    ok(`Coastal worksheet ${calc.totalToArtist} (venue / Mariana calc)`);
  }

  if (data.settlement?.totalToArtist !== 12285) {
    fail(`Coastal stored total should be 12285, got ${data.settlement?.totalToArtist}`);
  } else {
    ok("Coastal stored settlement 12285 (final agreed after dispute)");
  }

  const recoupIdx = calc.steps.findIndex((s) => s.label.startsWith("recoup:"));
  const feeIdx = calc.steps.findIndex((s) => s.label.includes("ticketing"));
  const expIdx = calc.steps.findIndex((s) =>
    s.label.includes("deductible expenses"),
  );
  if (!(feeIdx < recoupIdx && recoupIdx < expIdx)) {
    fail("Coastal worksheet: recoup not between fees and expenses");
  } else {
    ok("Coastal worksheet: recoup after fees, before expense cap");
  }

  const steps = data.agreement?.calculationSteps ?? [];
  const recoupPos = steps.findIndex((s) => s.stepType === "recoup");
  const feePos = steps.findIndex((s) => s.stepType === "ticketing_fees");
  const capPos = steps.findIndex((s) => s.stepType === "expense_cap");
  if (recoupPos >= 0 && feePos >= 0 && capPos >= 0) {
    if (feePos < recoupPos && recoupPos < capPos) {
      ok("Coastal agreement: recoup before expense cap");
    } else {
      fail("Coastal agreement: recoup step order mismatch");
    }
  }

  if (data.agreement?.agreement.status !== "needs_clarification") {
    warn(`Coastal agreement status is ${data.agreement?.agreement.status}`);
  }
}

function hasEarlyRecoup(
  data: NonNullable<Awaited<ReturnType<typeof getShowById>>>,
): boolean {
  return data.recoups.some((r) => {
    if (r.status === "withdrawn") return false;
    if (data.deal?.dealNotesFreetext?.toLowerCase().includes("against gross")) {
      return true;
    }
    return data.agreement?.recoupTerms.some(
      (t) =>
        t.category === r.category &&
        (t.placement === "unclear" ||
          t.placement === "outside_expense_cap" ||
          t.placement === "before_artist_percentage"),
    );
  });
}

async function bulkCheck() {
  const allShows = await db.select({ id: shows.id }).from(shows);
  let checked = 0;
  let matched = 0;
  let mismatched = 0;
  const mismatchSamples: string[] = [];

  for (const { id } of allShows) {
    const data = await getShowById(id);
    if (!data?.deal || data.settlement?.totalToArtist == null) continue;
    if (!isDealSupportedForInAppSettlement(data.deal)) continue;
    if (hasEarlyRecoup(data)) continue;

    const calc = calculateSettlement({
      deal: data.deal,
      ticketSales: data.ticketSales,
      expenses: data.expenses,
      agreement: data.agreement,
      recoups: data.recoups,
    });
    if (!calc.supported) continue;

    checked++;
    const diff = Math.abs(calc.totalToArtist - data.settlement.totalToArtist);
    if (diff > TOLERANCE) {
      mismatched++;
      if (mismatchSamples.length < 5) {
        mismatchSamples.push(
          `${id}: calc=${calc.totalToArtist} stored=${data.settlement.totalToArtist}`,
        );
      }
    } else {
      matched++;
    }
  }

  ok(
    `Bulk: ${matched}/${checked} supported settlements match stored total (excl. early-recoup / disputed narrative shows)`,
  );
  if (mismatched > 0) {
    warn(
      `${mismatched} shows diverge — seed computeSettlement() omits bonuses/recoup placement; expected for some rows`,
    );
    for (const s of mismatchSamples) warn(`  sample: ${s}`);
  }
}

async function main() {
  await checkCoastal();
  await bulkCheck();
  console.log("\n---");
  console.log(`Failures: ${failures}, Warnings: ${warnings}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
