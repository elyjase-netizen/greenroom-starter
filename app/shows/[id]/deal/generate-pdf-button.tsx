"use client";

import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GeneratePdfButton() {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => window.print()}
      className="print:hidden"
    >
      <FileDown className="h-4 w-4" />
      Generate PDF
    </Button>
  );
}
