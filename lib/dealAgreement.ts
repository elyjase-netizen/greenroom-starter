import type {
  DealAgreement,
  DealAgreementEvent,
  DealCalculationStep,
  DealExpenseTerm,
  DealRecoupTerm,
} from "@/db/schema";

export type DealAgreementBundle = {
  agreement: DealAgreement;
  calculationSteps: DealCalculationStep[];
  expenseTerms: DealExpenseTerm[];
  recoupTerms: DealRecoupTerm[];
  events: DealAgreementEvent[];
};

export const AGREEMENT_STATUS_LABELS: Record<DealAgreement["status"], string> = {
  draft: "Draft",
  needs_clarification: "Needs clarification",
  ready_for_agent_review: "Ready for agent review",
  agreed: "Agreed",
  changed_after_agreement: "Changed after agreement",
};

export const AGREEMENT_STATUS_VARIANTS: Record<
  DealAgreement["status"],
  "default" | "amber" | "brand" | "rose" | "sky"
> = {
  draft: "default",
  needs_clarification: "amber",
  ready_for_agent_review: "sky",
  agreed: "brand",
  changed_after_agreement: "rose",
};

export const EXPENSE_TERM_LABELS: Record<DealExpenseTerm["category"], string> = {
  production: "Production",
  sound: "Sound",
  lights: "Lights",
  hospitality: "Hospitality",
  marketing: "Marketing",
  backline: "Backline",
  security: "Security",
  other: "Other",
};

export const EXPENSE_TREATMENT_LABELS: Record<
  DealExpenseTerm["treatment"],
  string
> = {
  included_in_cap: "Included in cap",
  outside_cap: "Outside cap",
  venue_absorbed: "Venue absorbed",
  reference_only: "Reference only",
  excluded: "Excluded",
};

export const RECOUP_PLACEMENT_LABELS: Record<DealRecoupTerm["placement"], string> =
  {
    inside_expense_cap: "Inside expense cap",
    outside_expense_cap: "Outside expense cap",
    before_artist_percentage: "Before artist percentage",
    after_artist_percentage: "After artist percentage",
    reference_only: "Reference only",
    unclear: "Unclear",
  };

export const CALCULATION_STEP_LABELS: Record<
  DealCalculationStep["stepType"],
  string
> = {
  gross_box_office: "Gross box office",
  ticketing_fees: "Ticketing / platform fees",
  recoup: "Recoup",
  expense_cap: "Expense cap",
  net_after_expenses: "Net after expenses",
  artist_percentage: "Artist percentage",
  guarantee_compare: "Guarantee comparison",
  bonus: "Bonus",
  manual_review: "Manual review",
};

export function agreementRiskFlags(bundle?: DealAgreementBundle | null): string[] {
  if (!bundle) {
    return ["No structured deal agreement on file."];
  }

  const flags: string[] = [];
  const { agreement, expenseTerms, recoupTerms, calculationSteps } = bundle;

  if (agreement.status === "needs_clarification") {
    flags.push("Agreement has unresolved clarification requests.");
  }
  if (agreement.status === "changed_after_agreement") {
    flags.push("Deal terms changed after the last agent agreement.");
  }
  if (recoupTerms.some((r) => r.placement === "unclear")) {
    flags.push("At least one recoup has unclear calculation placement.");
  }
  if (
    recoupTerms.some((r) => r.category === "marketing") &&
    !recoupTerms.every((r) => r.category !== "marketing" || r.placement !== "unclear")
  ) {
    flags.push("Marketing recoup needs inside/outside cap confirmation.");
  }
  if (
    expenseTerms.some((e) => e.category === "hospitality") &&
    expenseTerms.every((e) => e.category !== "hospitality" || e.capAmount == null)
  ) {
    flags.push("Hospitality is in scope but no category cap is recorded.");
  }
  if (calculationSteps.some((s) => s.stepType === "manual_review")) {
    flags.push("Agreement includes terms the engine still marks for manual review.");
  }

  return flags;
}

export function agreementReadyForSettlement(
  bundle?: DealAgreementBundle | null,
): boolean {
  if (!bundle) return false;
  return (
    bundle.agreement.status === "agreed" &&
    agreementRiskFlags(bundle).length === 0
  );
}
