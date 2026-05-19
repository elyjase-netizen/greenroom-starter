/**
 * Deal calculation logic for the in-app settlement tool.
 *
 * IMPORTANT — DELIBERATELY INCOMPLETE beyond supported subsets.
 *
 * Handles end-to-end:
 *
 *   1. flat                   — $X guaranteed; structured bonuses (sellout, etc.)
 *   2. percentage_of_gross    — X% of gross, no expense deductions; bonuses
 *   3. vs (standard only)     — guarantee vs X% of net after capped expenses,
 *                               whichever greater; structured gross-threshold
 *                               bonuses apply only when the percentage share wins.
 *
 * Standard vs excludes:
 *
 *   - vs deals with percentage_basis === gross (% of gross, no expense path)
 *   - tier ratchet escalators (`tier_ratchet` in bonuses_json)
 *   - walkout-pot variants (structured gross_threshold bonuses whose label
 *     mentions "walkout" — seeded modeling)
 *
 * Still unsupported:
 *
 *   - percentage_of_net, door, non-standard vs (above), comps that adjust gross,
 *     tier ratchets, prose-only bonuses
 *
 * Recoups follow agreement placement when available: "against gross" / unclear /
 * outside-cap recoups deduct after fees and before the expense cap on VS deals;
 * others deduct after deal math (final artist payment).
 *
 * For unsupported deals, the tool returns { supported: false }.
 */

import type {
  Deal,
  Expense,
  TicketSale,
  Bonus,
  Recoup,
  DealRecoupTerm,
} from "@/db/schema";
import { formatMoney } from "@/lib/format";
import {
  agreementRiskFlags,
  type DealAgreementBundle,
} from "@/lib/dealAgreement";

export type SettlementCalculation =
  | {
      supported: true;
      grossBoxOffice: number;
      netBoxOffice: number;
      totalExpenses: number;
      totalToArtist: number;
      steps: {
        label: string;
        value: number;
        note?: string;
        /** Indented under this row (e.g. expense-cap deal categories — labels only). */
        detailLines?: string[];
        /** Present on recoup deduction rows in the worksheet. */
        recoupStatus?: Recoup["status"];
      }[];
      finalFormula: string;
      agreementContext?: {
        version: number;
        status: DealAgreementBundle["agreement"]["status"];
        calculationSteps: string[];
        warnings: string[];
      };
      // Bonuses that were applied. Empty array if no bonuses on the deal,
      // or if no bonuses triggered.
      bonusesApplied: { label: string; amount: number; reason: string }[];
      // Bonuses that exist on the deal but didn't trigger (helpful context).
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
    };

interface CalcInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  // Capacity is needed to evaluate sellout bonuses. Optional — if omitted,
  // sellout bonuses are reported as "can't determine".
  venueCapacity?: number;
  ticketsSold?: number;
  agreement?: DealAgreementBundle | null;
  recoups?: Recoup[];
}

const RECOUP_CATEGORY_LABELS: Record<Recoup["category"], string> = {
  marketing: "Marketing",
  hospitality_overage: "Hospitality overage",
  production_overage: "Production overage",
  prior_advance: "Prior advance",
  damages: "Damages",
  other: "Other",
};

type SupportedSettlement = Extract<SettlementCalculation, { supported: true }>;

type RecoupTiming = "before_expense_cap" | "after_deal_math";

function matchingRecoupTerm(
  recoup: Recoup,
  agreement?: DealAgreementBundle | null,
): DealRecoupTerm | undefined {
  if (!agreement?.recoupTerms.length) return undefined;
  return agreement.recoupTerms.find(
    (t) =>
      t.category === recoup.category &&
      (t.amount == null || t.amount === recoup.amount),
  );
}

/** When recoups apply in the VS waterfall (matches deal-agreement step order). */
export function recoupTiming(
  recoup: Recoup,
  deal: Deal,
  agreement?: DealAgreementBundle | null,
): RecoupTiming {
  const placement = matchingRecoupTerm(recoup, agreement)?.placement;
  if (
    placement === "before_artist_percentage" ||
    placement === "outside_expense_cap"
  ) {
    return "before_expense_cap";
  }
  if (placement === "unclear") {
    return "before_expense_cap";
  }
  if (placement === "inside_expense_cap" || placement === "reference_only") {
    return "after_deal_math";
  }
  if (placement === "after_artist_percentage") {
    return "after_deal_math";
  }
  const notes = deal.dealNotesFreetext?.toLowerCase() ?? "";
  if (notes.includes("against gross")) {
    return "before_expense_cap";
  }
  return "after_deal_math";
}

function partitionRecoups(
  recoups: Recoup[],
  deal: Deal,
  agreement?: DealAgreementBundle | null,
): { early: Recoup[]; late: Recoup[] } {
  const early: Recoup[] = [];
  const late: Recoup[] = [];
  for (const r of recoups) {
    if (r.status === "withdrawn") continue;
    if (recoupTiming(r, deal, agreement) === "before_expense_cap") {
      early.push(r);
    } else {
      late.push(r);
    }
  }
  return { early, late };
}

function recoupWorksheetRows(recoups: Recoup[]): SupportedSettlement["steps"] {
  return recoups.map((r) => ({
    label: `recoup: ${r.label}`,
    value: -r.amount,
    note: RECOUP_CATEGORY_LABELS[r.category],
    recoupStatus: r.status,
  }));
}

function appendLateRecoupSteps(
  calc: SupportedSettlement,
  lateRecoups: Recoup[],
): SupportedSettlement {
  if (lateRecoups.length === 0) return calc;

  const steps = [...calc.steps, ...recoupWorksheetRows(lateRecoups)];
  const recoupTotal = lateRecoups.reduce((s, r) => s + r.amount, 0);
  const totalToArtist =
    Math.round((calc.totalToArtist - recoupTotal) * 100) / 100;

  return {
    ...calc,
    steps,
    totalToArtist,
    finalFormula: `${calc.finalFormula} − recoups ${recoupTotal.toFixed(2)} = ${totalToArtist.toFixed(2)}`,
  };
}

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Sub-label math for the worksheet "Gross box office" row (from ticket_sales rows). */
function worksheetNoteForGrossBoxOffice(
  ticketSales: TicketSale[],
  grossTotal: number,
): string {
  if (ticketSales.length === 0) {
    return "No ticket_sales rows.";
  }
  const qtyTotal = ticketSales.reduce((s, t) => s + (t.qty ?? 0), 0);
  if (ticketSales.length === 1) {
    if (qtyTotal <= 0) {
      return "Ticket quantity is zero in ticket_sales.";
    }
    const perTicket = grossTotal / qtyTotal;
    return `${qtyTotal.toLocaleString("en-US")} tickets × ${formatMoney(perTicket)} avg gross per ticket`;
  }
  const chunks = ticketSales.map((t) => formatMoney(t.gross)).join(" + ");
  return `${qtyTotal.toLocaleString("en-US")} tickets · ${ticketSales.length} snapshots summed (${chunks}).`;
}

const EXPENSE_CATEGORY_ORDER: Expense["category"][] = [
  "sound",
  "lights",
  "production",
  "marketing",
  "hospitality",
  "backline",
  "security",
  "other",
];

const EXPENSE_CATEGORY_LABELS: Record<Expense["category"], string> = {
  sound: "Sound",
  lights: "Lights",
  production: "Production",
  marketing: "Marketing",
  hospitality: "Hospitality",
  backline: "Backline",
  security: "Security",
  other: "Other",
};

/** Categories the deal text / structured caps imply are in scope (no DB field for this). */
function dealReferencedExpenseCategories(deal: Deal): Set<Expense["category"]> {
  const out = new Set<Expense["category"]>();
  const notes = deal.dealNotesFreetext?.toLowerCase() ?? "";
  const keywordPairs: [Expense["category"], RegExp][] = [
    ["sound", /\b(sound|pa|audio)\b/],
    ["lights", /\b(light|lighting|lx)\b/],
    ["production", /\bproduction\b/],
    ["marketing", /\bmarket/],
    ["hospitality", /\b(hospitality|hosp|catering)\b/],
    ["backline", /\bbackline\b/],
    ["security", /\bsecurity\b/],
    ["other", /\b(misc|miscellaneous)\b/],
  ];
  for (const [cat, re] of keywordPairs) {
    if (re.test(notes)) out.add(cat);
  }
  if (deal.hospitalityCap != null) out.add("hospitality");
  return out;
}

/** Category names in deal/show scope for expense-cap worksheet detail (no amounts). */
function worksheetExpenseCapCategoryLabels(
  expenses: Expense[],
  deal: Deal,
): string[] {
  const passThrough = new Set<Expense["category"]>();
  const absorbed = new Set<Expense["category"]>();
  for (const e of expenses) {
    (e.absorbedByVenue ? absorbed : passThrough).add(e.category);
  }
  const dealCats = dealReferencedExpenseCategories(deal);
  const seen = new Set<Expense["category"]>([
    ...passThrough,
    ...absorbed,
    ...dealCats,
  ]);

  const labels: string[] = [];
  for (const cat of EXPENSE_CATEGORY_ORDER) {
    if (!seen.has(cat)) continue;
    labels.push(EXPENSE_CATEGORY_LABELS[cat]);
  }

  if (labels.length === 0 && deal.expenseCap != null) {
    return EXPENSE_CATEGORY_ORDER.map((c) => EXPENSE_CATEGORY_LABELS[c]);
  }

  return labels;
}

const WALKOUT_LABEL_RE = /\bwalkout\b/i;
const PROSE_BONUS_RE =
  /\b(bonus|bonuses|escalator|ratchet|walkout|sellout)\b/i;

function hasProseOnlyBonusReference(deal: Deal): boolean {
  return (
    parseBonuses(deal).length === 0 &&
    PROSE_BONUS_RE.test(deal.dealNotesFreetext ?? "")
  );
}

/** Structured exclusions — prose-only detection stays out of the engine. */
function classifyStandardVsDeal(deal: Deal):
  | { supported: true }
  | { supported: false; reason: string } {
  const bonuses = parseBonuses(deal);

  if (deal.percentageBasis !== "net") {
    return {
      supported: false,
      reason:
        deal.percentageBasis === "gross"
          ? "Vs (% of gross) deals aren't supported in the in-app tool yet."
          : "Vs deal is missing percentage_basis = net for standard settlement.",
    };
  }

  if (bonuses.some((b) => b.type === "tier_ratchet")) {
    return {
      supported: false,
      reason:
        "Tier ratchet vs deals aren't supported in the in-app tool yet.",
    };
  }

  if (
    bonuses.some(
      (b) =>
        b.type === "gross_threshold" && WALKOUT_LABEL_RE.test(b.label ?? ""),
    )
  ) {
    return {
      supported: false,
      reason:
        "Walkout-pot vs deals aren't supported in the in-app tool yet.",
    };
  }

  return { supported: true };
}

/** True when `calculateSettlement` can return `supported: true` (deal rows only — no show inputs). */
export function isDealSupportedForInAppSettlement(deal: Deal): boolean {
  if (hasProseOnlyBonusReference(deal)) return false;

  switch (deal.dealType) {
    case "flat":
      return deal.guaranteeAmount != null;
    case "percentage_of_gross":
      return deal.percentage != null;
    case "vs":
      if (deal.guaranteeAmount == null || deal.percentage == null) return false;
      return classifyStandardVsDeal(deal).supported;
    default:
      return false;
  }
}

/** Flat worksheets include gross/net/expense rows only when the deal ties prose or structured fields to expenses. */
export function flatShowsExpenseContextInWorksheet(deal: Deal): boolean {
  if (deal.dealType !== "flat") return false;
  if (deal.expenseCap != null) return true;
  const notes = deal.dealNotesFreetext?.trim();
  if (!notes) return false;
  const n = notes.toLowerCase();
  if (/\bno\s+expenses?\b/.test(n)) return false;
  if (/\bno\s+expense\b/.test(n)) return false;
  return (
    /\bexpenses?\b/.test(n) ||
    /\bexpense\s+cap\b/.test(n) ||
    /\bafter\s+expenses?\b/.test(n)
  );
}

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const {
    deal,
    ticketSales,
    expenses,
    venueCapacity,
    ticketsSold,
    agreement,
    recoups = [],
  } = input;
  const agreementContext = agreement
    ? {
        version: agreement.agreement.version,
        status: agreement.agreement.status,
        calculationSteps: agreement.calculationSteps.map((s) => s.label),
        warnings: agreementRiskFlags(agreement),
      }
    : undefined;

  const grossBoxOffice = ticketSales.reduce((sum, t) => sum + t.gross, 0);
  const totalFees = ticketSales.reduce((sum, t) => sum + t.fees, 0);
  const netBoxOffice = grossBoxOffice - totalFees;
  const totalExpenses = expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);

  const tickets =
    ticketsSold ?? ticketSales.reduce((sum, t) => sum + (t.qty ?? 0), 0);

  const grossBoxOfficeNote = worksheetNoteForGrossBoxOffice(
    ticketSales,
    grossBoxOffice,
  );

  if (hasProseOnlyBonusReference(deal)) {
    return {
      supported: false,
      reason:
        "Deal references bonuses in the email, but those terms aren't structured for in-app settlement.",
      dealType: deal.dealType,
    };
  }

  // ---------- flat guarantee ----------
  if (deal.dealType === "flat") {
    if (deal.guaranteeAmount == null) {
      return {
        supported: false,
        reason: "Flat deal is missing a guarantee amount.",
        dealType: deal.dealType,
      };
    }
    const bonusResult = applyBonuses(parseBonuses(deal), {
      gross: grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    });

    const economicsPrefix: {
      label: string;
      value: number;
      note?: string;
      detailLines?: string[];
    }[] =
      flatShowsExpenseContextInWorksheet(deal)
        ? [
            {
              label: "Gross box office",
              value: grossBoxOffice,
              note: grossBoxOfficeNote,
            },
            {
              label: "Net box office",
              value: netBoxOffice,
              note: "Gross − fees.",
            },
            ...(deal.expenseCap != null
              ? [
                  {
                    label: "Deal expense cap",
                    value: deal.expenseCap,
                    note:
                      "For reference — flat payout does not deduct expenses in the engine.",
                    detailLines:
                      worksheetExpenseCapCategoryLabels(expenses, deal),
                  },
                ]
              : [
                  {
                    label: "Total expenses (passed through)",
                    value: totalExpenses,
                    note:
                      "For context — this flat payout does not deduct expenses in the engine.",
                  },
                ]),
          ]
        : [];

    const { late: lateRecoups } = partitionRecoups(recoups, deal, agreement);
    return appendLateRecoupSteps(
      {
        supported: true,
        grossBoxOffice,
        netBoxOffice,
        totalExpenses,
        totalToArtist: deal.guaranteeAmount + bonusResult.totalApplied,
        steps: [
          ...economicsPrefix,
          {
            label: "Flat guarantee",
            value: deal.guaranteeAmount,
            note: "No expense deductions. The guarantee is the floor.",
          },
          ...bonusResult.applied.map((b) => ({
            label: b.label,
            value: b.amount,
            note: b.reason,
          })),
        ],
        finalFormula: bonusResult.applied.length
          ? `flat ${deal.guaranteeAmount} + bonuses ${bonusResult.totalApplied} = ${(deal.guaranteeAmount + bonusResult.totalApplied).toFixed(2)}`
          : `flat guarantee = ${deal.guaranteeAmount}`,
        agreementContext,
        bonusesApplied: bonusResult.applied,
        bonusesNotTriggered: bonusResult.notTriggered,
      },
      lateRecoups,
    );
  }

  // ---------- percentage of gross ----------
  if (deal.dealType === "percentage_of_gross") {
    if (deal.percentage == null) {
      return {
        supported: false,
        reason: "Percentage-of-gross deal is missing a percentage.",
        dealType: deal.dealType,
      };
    }
    const payout = grossBoxOffice * deal.percentage;
    const bonusResult = applyBonuses(parseBonuses(deal), {
      gross: grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    });

    const { late: lateRecoupsPctGross } = partitionRecoups(
      recoups,
      deal,
      agreement,
    );
    return appendLateRecoupSteps(
      {
        supported: true,
        grossBoxOffice,
        netBoxOffice,
        totalExpenses,
        totalToArtist: payout + bonusResult.totalApplied,
        steps: [
          {
            label: "Gross box office",
            value: grossBoxOffice,
            note: grossBoxOfficeNote,
          },
          {
            label: `× ${(deal.percentage * 100).toFixed(0)}%`,
            value: payout,
            note: "Percentage of gross — no expense deductions.",
          },
          ...bonusResult.applied.map((b) => ({
            label: b.label,
            value: b.amount,
            note: b.reason,
          })),
        ],
        finalFormula: bonusResult.applied.length
          ? `gross × ${deal.percentage} + bonuses = ${(payout + bonusResult.totalApplied).toFixed(2)}`
          : `gross × ${deal.percentage} = ${payout.toFixed(2)}`,
        agreementContext,
        bonusesApplied: bonusResult.applied,
        bonusesNotTriggered: bonusResult.notTriggered,
      },
      lateRecoupsPctGross,
    );
  }

  // ---------- standard vs (guarantee vs % of net after capped expenses) ----------
  if (deal.dealType === "vs") {
    if (deal.guaranteeAmount == null || deal.percentage == null) {
      return {
        supported: false,
        reason: "Vs deal is missing a guarantee amount or percentage.",
        dealType: deal.dealType,
      };
    }

    const standardCheck = classifyStandardVsDeal(deal);
    if (!standardCheck.supported) {
      return {
        supported: false,
        reason: standardCheck.reason,
        dealType: deal.dealType,
      };
    }

    const { early: earlyRecoups, late: lateRecoups } = partitionRecoups(
      recoups,
      deal,
      agreement,
    );
    const earlyRecoupTotal = earlyRecoups.reduce((s, r) => s + r.amount, 0);
    const netAfterEarlyRecoups = netBoxOffice - earlyRecoupTotal;

    const capLimit =
      deal.expenseCap != null ? deal.expenseCap : Number.POSITIVE_INFINITY;
    const expenseDeduction =
      deal.expenseCap != null && earlyRecoups.length > 0
        ? deal.expenseCap
        : Math.min(totalExpenses, capLimit);
    const netAfterExpenses = Math.max(0, netAfterEarlyRecoups - expenseDeduction);
    const pctPayout = netAfterExpenses * deal.percentage;
    const guarantee = deal.guaranteeAmount;
    const base = Math.max(guarantee, pctPayout);
    const pctSideWins = pctPayout >= guarantee;

    const allBonuses = parseBonuses(deal);

    const grossSteps = (
      grossBonuses: Extract<Bonus, { type: "gross_threshold" }>[],
      pctSideWinsLocal: boolean,
    ): {
      applied: { label: string; amount: number; reason: string }[];
      notTriggered: { label: string; amount: number; reason: string }[];
      grossBonusSum: number;
    } => {
      const applied: { label: string; amount: number; reason: string }[] = [];
      const notTriggered: { label: string; amount: number; reason: string }[] =
        [];
      let grossBonusSum = 0;

      if (!pctSideWinsLocal) {
        for (const b of grossBonuses) {
          notTriggered.push({
            label: b.label,
            amount: b.amount,
            reason:
              "Percentage share is below guarantee — gross-threshold bonuses don't stack on vs deals (seeded convention).",
          });
        }
        return { applied, notTriggered, grossBonusSum };
      }

      for (const b of grossBonuses) {
        if (grossBoxOffice >= b.threshold) {
          grossBonusSum += b.amount;
          applied.push({
            label: b.label,
            amount: b.amount,
            reason: `Gross ${grossBoxOffice.toLocaleString()} ≥ ${b.threshold.toLocaleString()}`,
          });
        } else {
          notTriggered.push({
            label: b.label,
            amount: b.amount,
            reason: `Gross ${grossBoxOffice.toLocaleString()} < ${b.threshold.toLocaleString()}`,
          });
        }
      }
      return { applied, notTriggered, grossBonusSum };
    };

    const grossBonuses = allBonuses.filter(
      (b): b is Extract<Bonus, { type: "gross_threshold" }> =>
        b.type === "gross_threshold",
    );
    const grossBonusEval = grossSteps(grossBonuses, pctSideWins);

    const skippedVsBonuses: {
      label: string;
      amount: number;
      reason: string;
    }[] = [];
    for (const b of allBonuses) {
      if (b.type === "sellout" || b.type === "attendance_threshold") {
        skippedVsBonuses.push({
          label: b.label,
          amount: b.amount,
          reason:
            "Sellout and attendance bonuses aren't applied on vs deals in this engine (matches seeded settlement totals).",
        });
      }
    }

    const bonusesApplied = grossBonusEval.applied;
    const bonusesNotTriggered = [
      ...grossBonusEval.notTriggered,
      ...skippedVsBonuses,
    ];

    const totalToArtist =
      Math.round((base + grossBonusEval.grossBonusSum) * 100) / 100;

    const expenseCapActive = deal.expenseCap != null;
    const expenseWorksheetSteps: {
      label: string;
      value: number;
      note?: string;
      detailLines?: string[];
    }[] = expenseCapActive
      ? [
          {
            label: "Less deductible expenses (capped)",
            value: -expenseDeduction,
            note:
              earlyRecoups.length > 0
                ? `Cap ${formatMoney(deal.expenseCap!)} applied after recoups (actual pass-through ${formatMoney(totalExpenses)}).`
                : totalExpenses > expenseDeduction
                  ? `Cap ${formatMoney(deal.expenseCap!)} — ${formatMoney(expenseDeduction)} applies to net (actual pass-through ${formatMoney(totalExpenses)}).`
                  : `Cap ${formatMoney(deal.expenseCap!)} — ${formatMoney(expenseDeduction)} deductible.`,
            detailLines: worksheetExpenseCapCategoryLabels(expenses, deal),
          },
        ]
      : [
          {
            label: "Passed-through expenses (for split)",
            value: totalExpenses,
            note: "No expense cap — full passed-through amount is deductible.",
          },
          {
            label: "Less deductible expenses (capped)",
            value: -expenseDeduction,
          },
        ];

    const steps: {
      label: string;
      value: number;
      note?: string;
      detailLines?: string[];
      recoupStatus?: Recoup["status"];
    }[] = [
      {
        label: "Gross box office",
        value: grossBoxOffice,
        note: grossBoxOfficeNote,
      },
      {
        label: "Less ticketing & platform fees",
        value: -totalFees,
      },
      {
        label: "Net box office",
        value: netBoxOffice,
        note: "Net box office = gross − fees.",
      },
      ...recoupWorksheetRows(earlyRecoups),
      ...expenseWorksheetSteps,
      {
        label: "Net after deductible expenses",
        value: netAfterExpenses,
        note:
          earlyRecoups.length > 0
            ? "max(0, net after recoups − expense cap)."
            : "max(0, net box office − capped expenses).",
      },
      {
        label: `${(deal.percentage * 100).toFixed(0)}% of net after expenses`,
        value: pctPayout,
      },
      { label: "Guarantee", value: guarantee },
      {
        label: "Greater of guarantee vs % share",
        value: base,
        note: pctSideWins
          ? "Percentage share wins."
          : "Guarantee wins.",
      },
      ...bonusesApplied.map((b) => ({
        label: b.label,
        value: b.amount,
        note: b.reason,
      })),
    ];

    const bonusTail = grossBonusEval.grossBonusSum;
    const finalFormula =
      bonusTail > 0
        ? `max(${guarantee}, ${deal.percentage}×net_after_exp) + bonuses = ${totalToArtist.toFixed(2)}`
        : `max(${guarantee}, ${deal.percentage}×net_after_exp) = ${totalToArtist.toFixed(2)}`;

    return appendLateRecoupSteps(
      {
        supported: true,
        grossBoxOffice,
        netBoxOffice,
        totalExpenses,
        totalToArtist,
        steps,
        finalFormula,
        agreementContext,
        bonusesApplied,
        bonusesNotTriggered,
      },
      lateRecoups,
    );
  }

  // ---------- everything else: not supported ----------
  const friendlyName: Record<Deal["dealType"], string> = {
    flat: "Flat guarantee",
    percentage_of_gross: "Percentage of gross",
    percentage_of_net: "Percentage of net",
    vs: "Vs deal (guarantee vs %)",
    door: "Door deal",
  };

  return {
    supported: false,
    dealType: deal.dealType,
    reason:
      `${friendlyName[deal.dealType]} deals aren't supported in the in-app tool yet. ` +
      `Power users at venues like The Crescent default to spreadsheets for these.`,
  };
}

/** Evaluate a list of bonuses against the show's actual numbers. */
function applyBonuses(
  bonuses: Bonus[],
  ctx: { gross: number; tickets: number; capacity?: number },
) {
  const applied: { label: string; amount: number; reason: string }[] = [];
  const notTriggered: { label: string; amount: number; reason: string }[] = [];

  for (const b of bonuses) {
    if (b.type === "gross_threshold") {
      if (ctx.gross >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} ≥ ${b.threshold.toLocaleString()}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} < ${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = ≥95%)`
              : `Capacity unknown — can't evaluate`,
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} ≥ ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    } else if (b.type === "tier_ratchet") {
      // Tier ratchets fundamentally change the percentage structure. The
      // current engine only supports flat % of gross — we can't apply a
      // ratcheting structure on top of it without knowing which deal type
      // it's modifying. Report as not-applicable.
      notTriggered.push({
        label: b.label,
        amount: 0,
        reason: "Tier ratchets need vs-deal or % of net support — not yet handled",
      });
    }
  }

  return {
    applied,
    notTriggered,
    totalApplied: applied.reduce((s, b) => s + b.amount, 0),
  };
}
