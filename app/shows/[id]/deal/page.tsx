import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Clock3,
  FileSpreadsheet,
} from "lucide-react";
import { getShowById } from "@/lib/queries";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
} from "@/components/ui/card";
import { PlainBadge, DealTypeBadge } from "@/components/ui/badge";
import {
  formatMoney,
  formatShowDateFull,
} from "@/lib/format";
import {
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_STATUS_VARIANTS,
  CALCULATION_STEP_LABELS,
  EXPENSE_TERM_LABELS,
  EXPENSE_TREATMENT_LABELS,
  RECOUP_PLACEMENT_LABELS,
  agreementReadyForSettlement,
  agreementRiskFlags,
} from "@/lib/dealAgreement";
import { isDealSupportedForInAppSettlement } from "@/lib/dealMath";
import { GeneratePdfButton } from "./generate-pdf-button";

export default async function DealAgreementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data) notFound();

  const { show, artist, agent, agency, deal, agreement } = data;
  if (!deal) notFound();

  const dealAgreementAvailable = isDealSupportedForInAppSettlement(deal);
  const flags = agreementRiskFlags(agreement);
  const ready = agreementReadyForSettlement(agreement);

  return (
    <div className="px-12 py-10 max-w-7xl print:px-0 print:py-0">
      <Link
        href={`/shows/${show.id}`}
        className="inline-flex items-center gap-1 text-[12px] text-ink-400 hover:text-ink-900 mb-8 transition-colors print:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to show
      </Link>

      <div className="mb-10 flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-1.5 mb-4">
            <DealTypeBadge type={deal.dealType} />
            {agreement ? (
              <PlainBadge variant={AGREEMENT_STATUS_VARIANTS[agreement.agreement.status]}>
                {AGREEMENT_STATUS_LABELS[agreement.agreement.status]}
              </PlainBadge>
            ) : (
              <PlainBadge variant="amber">Not structured</PlainBadge>
            )}
          </div>
          <h1
            className="font-display text-[48px] font-medium text-ink-900 leading-[1.05]"
            style={{ letterSpacing: "-0.02em", fontOpticalSizing: "auto" }}
          >
            Deal agreement · {artist?.name}
          </h1>
          <div className="text-[14px] text-ink-400 mt-3">
            {formatShowDateFull(show.date)}
            {agent && (
              <>
                {" "}
                · {agent.name}
                {agency ? `, ${agency.name}` : ""}
              </>
            )}
          </div>
        </div>
        {dealAgreementAvailable && (
          <div className="mt-2 flex items-center gap-2 shrink-0 print:hidden">
            <GeneratePdfButton />
            <Link
              href={`/shows/${show.id}/settle`}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-4 h-9 text-[13px] font-medium text-white shadow-sm shadow-brand-700/15 ring-1 ring-inset ring-brand-800/20 transition-all duration-150 hover:bg-brand-800 active:translate-y-px"
            >
              <FileSpreadsheet className="h-4 w-4" />
              View settlement
            </Link>
          </div>
        )}
      </div>

      {!dealAgreementAvailable ? (
        <Card accent="amber">
          <CardHeader>
            <CardTitle>Deal agreement unavailable</CardTitle>
            <CardDescription>
              This workflow is limited to deals the app can settle today.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-[13px] text-ink-600 leading-relaxed">
            Deal agreements and in-app settlement for deals with walk-out pots,
            tier ratchets, and vs-% of gross are coming soon!
          </CardContent>
        </Card>
      ) : !agreement ? (
        <Card accent="amber">
          <CardHeader>
            <CardTitle>No structured agreement</CardTitle>
            <CardDescription>
              This show still only has legacy deal fields and free-text notes.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-[13px] text-ink-600 leading-relaxed">
            Create a structured agreement before show night so expense scope,
            recoups, and calculation order are clear before settlement.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          <Card accent={ready ? "brand" : flags.length ? "amber" : "sky"}>
            <CardHeader>
              <div>
                <CardTitle>Agreement status</CardTitle>
                <CardDescription>
                  Version {agreement.agreement.version} of the deal memo.
                </CardDescription>
              </div>
              <PlainBadge variant={ready ? "brand" : flags.length ? "amber" : "sky"}>
                {ready ? "Settlement-ready" : "Review needed"}
              </PlainBadge>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="md:col-span-2">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-900">
                  {ready ? (
                    <CheckCircle2 className="h-4 w-4 text-brand-700" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-700" />
                  )}
                  {AGREEMENT_STATUS_LABELS[agreement.agreement.status]}
                </div>
                <p className="text-[13px] text-ink-700 leading-relaxed mt-3">
                  {agreement.agreement.sourceSummary}
                </p>
                {agreement.agreement.readinessSummary && (
                  <p className="text-[12.5px] text-ink-500 leading-relaxed mt-2">
                    {agreement.agreement.readinessSummary}
                  </p>
                )}
              </div>
              <div className="rounded-lg bg-canvas-soft ring-1 ring-ink-200/50 p-4 space-y-3">
                <Field
                  label="Locked"
                  value={
                    agreement.agreement.lockedAt
                      ? agreement.agreement.lockedAt.toLocaleDateString()
                      : "Not locked"
                  }
                />
                <Field
                  label="Venue approval"
                  value={
                    agreement.agreement.venueApprovedAt
                      ? agreement.agreement.venueApprovedAt.toLocaleDateString()
                      : "Pending"
                  }
                />
                <Field
                  label="Agent approval"
                  value={
                    agreement.agreement.agentApprovedAt
                      ? agreement.agreement.agentApprovedAt.toLocaleDateString()
                      : "Pending"
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Deal terms</CardTitle>
                <CardDescription>
                  Structured values translated from the deal memo.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field
                  label="Guarantee"
                  mono
                  value={
                    deal.guaranteeAmount != null
                      ? formatMoney(deal.guaranteeAmount)
                      : "—"
                  }
                />
                <Field
                  label="Percentage"
                  mono
                  value={
                    deal.percentage != null
                      ? `${(deal.percentage * 100).toFixed(0)}%`
                      : "—"
                  }
                />
                <Field label="Basis" value={deal.percentageBasis ?? "—"} />
                <Field
                  label="Expense cap"
                  mono
                  value={
                    deal.expenseCap != null ? formatMoney(deal.expenseCap) : "—"
                  }
                />
                <Field
                  label="Hospitality cap"
                  mono
                  value={
                    deal.hospitalityCap != null
                      ? formatMoney(deal.hospitalityCap)
                      : "—"
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Source</CardTitle>
                <CardDescription>
                  The email language this structured version replaces.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-[12.5px] text-ink-700 bg-canvas-soft rounded-lg p-4 ring-1 ring-ink-200/50 leading-relaxed font-[450] italic">
                  {deal.dealNotesFreetext ?? "No free-text deal memo."}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Calculation order</CardTitle>
                <CardDescription>
                  The exact sequence settlement should follow.
                </CardDescription>
              </div>
              <PlainBadge variant="default">
                {agreement.calculationSteps.length} steps
              </PlainBadge>
            </CardHeader>
            <CardContent className="divide-y divide-ink-100/80">
              {agreement.calculationSteps.map((step) => (
                <div
                  key={step.id}
                  className="py-3 flex items-start gap-3"
                >
                  <div className="mt-0.5 h-6 w-6 rounded-full bg-ink-100 text-ink-600 text-[11px] font-mono flex items-center justify-center shrink-0">
                    {step.position}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink-900">
                      {step.label}
                    </div>
                    <div className="text-[11.5px] text-ink-400 mt-0.5">
                      {CALCULATION_STEP_LABELS[step.stepType]}
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Expenses & caps</CardTitle>
                  <CardDescription>
                    Which categories are included, excluded, or absorbed.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {agreement.expenseTerms.length === 0 ? (
                  <div className="text-[13px] text-ink-400">
                    No expense cap categories are attached to this deal.
                  </div>
                ) : (
                  <div className="divide-y divide-ink-100/80">
                    {agreement.expenseTerms.map((term) => (
                      <div
                        key={term.id}
                        className="py-3 flex items-start justify-between gap-4"
                      >
                        <div>
                          <div className="text-[13px] text-ink-900">
                            {EXPENSE_TERM_LABELS[term.category]}
                          </div>
                          <div className="text-[11.5px] text-ink-400 mt-0.5">
                            {EXPENSE_TREATMENT_LABELS[term.treatment]}
                            {term.capAmount != null &&
                              ` · cap ${formatMoney(term.capAmount)}`}
                          </div>
                          {term.notes && (
                            <div className="text-[11.5px] text-ink-500 mt-1 leading-snug">
                              {term.notes}
                            </div>
                          )}
                        </div>
                        <PlainBadge
                          variant={
                            term.treatment === "included_in_cap"
                              ? "brand"
                              : term.treatment === "reference_only"
                                ? "amber"
                                : "default"
                          }
                        >
                          {EXPENSE_TREATMENT_LABELS[term.treatment]}
                        </PlainBadge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Recoups</CardTitle>
                  <CardDescription>
                    Separate venue costs with explicit calculation placement.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {agreement.recoupTerms.length === 0 ? (
                  <div className="text-[13px] text-ink-400">
                    No recoups are attached to this agreement.
                  </div>
                ) : (
                  <div className="divide-y divide-ink-100/80">
                    {agreement.recoupTerms.map((recoup) => (
                      <div
                        key={recoup.id}
                        className="py-3 flex items-start justify-between gap-4"
                      >
                        <div>
                          <div className="text-[13px] text-ink-900">
                            {recoup.label}
                          </div>
                          <div className="text-[11.5px] text-ink-400 mt-0.5">
                            {RECOUP_PLACEMENT_LABELS[recoup.placement]}
                            {recoup.source ? ` · ${recoup.source}` : ""}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono tabular text-[13px] text-ink-900">
                            {recoup.amount != null
                              ? formatMoney(recoup.amount)
                              : "TBD"}
                          </div>
                          {recoup.requiresApproval && (
                            <div className="text-[11px] text-amber-700 mt-1">
                              approval required
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Review history</CardTitle>
                <CardDescription>
                  Paper trail for what changed and who accepted it.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="divide-y divide-ink-100/80">
              {agreement.events.map((event) => (
                <div key={event.id} className="py-3 flex gap-3">
                  <Clock3 className="h-3.5 w-3.5 text-ink-400 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-[13px] text-ink-900">
                      {event.summary}
                    </div>
                    <div className="text-[11.5px] text-ink-400 mt-0.5">
                      {event.actor} · {event.createdAt.toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
