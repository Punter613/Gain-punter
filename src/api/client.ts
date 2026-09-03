import createClient from "openapi-fetch";
import type { paths, components } from "../types/api";

const client = createClient<paths>({
  baseUrl: "/", // Cloudflare Pages Edge target
});

export async function getEstimate(body: {
  id: string;
  labor: number;
  parts: number;
  vin: string;
}) {
  const { data, error } = await client.POST("/api/estimateHeuristic", {
    body,
  });
  if (error) throw error;
  return data;
}

export async function diagnose(body: {
  id: string;
  vehicle?: {
    year?: number;
    make?: string;
    trim?: string;
  };
  /**
   * Source-aware DTC input. Only SCAN_TOOL records with verified=true are
   * admitted to diagnostic reasoning; all other sources are audit-only.
   */
  dtcEvidence?: Array<{
    code: string;
    source: "SCAN_TOOL" | "MANUAL_ENTRY" | "CUSTOMER_REPORTED" | "PLACEHOLDER" | "LEGACY_UNSPECIFIED";
    verified: boolean;
  }>;
  /** @deprecated Legacy arrays have no provenance and are treated as untrusted. */
  obdCodes?: string[];
  customerStates?: string[];
}) {
  const { data, error } = await client.POST("/api/diagnose", {
    body,
  });
  if (error) throw error;
  return data;
}

export async function getInvoice(body: {
  id: string;
  customer: {
    name?: string;
    phone?: string;
  };
  vehicle: {
    year?: number;
    make?: string;
    model?: string;
    trim?: string;
  };
  labor: number;
  parts: components["schemas"]["Part"][];
  codes: string[];
}) {
  const { data, error } = await client.POST("/api/invoice", {
    body,
  });
  if (error) throw error;
  return data;
}
