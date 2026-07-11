/** Signer as supplied when creating an envelope. */
export interface SignerCreate {
  email: string;
  name: string;
  phone?: string;
}

/** Carbon-copy recipient (receives the completed document, does not sign). */
export interface CcRecipient {
  email: string;
  name?: string;
}

/** Options accepted by POST /api/v1/envelopes. */
export interface EnvelopeCreate {
  template_id: string;
  signers: SignerCreate[];
  /** Pre-filled field values keyed by field name. */
  fields?: Record<string, unknown>;
  /** HTTPS URL that receives signed webhook callbacks for this envelope. */
  callback_url?: string;
  cc?: CcRecipient[];
  message?: string;
  /** Signing-page language (26 supported, e.g. "en", "es", "ja"). */
  lang?: string;
  org_id?: string;
  embedded?: boolean;
  test_mode?: boolean;
  in_person?: boolean;
  /** Enforce sequential signing order. */
  sign_order?: boolean;
  access_code?: string;
  require_id_verification?: boolean;
}

export interface EnvelopeCreateResult {
  id: string;
  status: string;
  template_id: string;
  signers: Array<Record<string, unknown>>;
  expires_at?: string;
  retention_years?: number;
  /** HMAC secret for `callback_url` deliveries (shown once). */
  callback_secret?: string;
  test_mode?: boolean;
  embedded?: boolean;
  in_person?: boolean;
  cc?: CcRecipient[];
}

export interface EnvelopeListItem {
  id: string;
  template_id: string;
  status: string;
  created_at: string;
  expires_at?: string | null;
  completed_at?: string | null;
  retention_years?: number;
  reminder_days?: number;
  max_reminders?: number;
  metadata?: Record<string, unknown> | null;
  sender_email?: string;
  sender_name?: string;
  archived_at?: string | null;
  source?: string;
}

export interface Envelope extends EnvelopeListItem {
  template_name?: string;
  has_access_code?: boolean;
  sign_order?: boolean;
}

/** Offset + cursor pagination block shared by every list endpoint. */
export interface Pagination {
  page?: number;
  total_pages?: number;
  limit: number;
  total: number;
  next_cursor?: string | null;
}

export interface EnvelopeList {
  envelopes: EnvelopeListItem[];
  pagination: Pagination;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  version?: number;
  category?: string;
  tags?: string[];
  roles?: string[];
  signer_count?: number;
  expiry_days?: number;
  created_at?: string;
  updated_at?: string;
  org_id?: string | null;
  created_by?: string | null;
  template_type?: string;
}

export interface Template extends TemplateSummary {
  disclaimer?: string;
  template_markdown?: string;
  hidden?: number;
}

export interface TemplateList {
  template_count: number;
  templates: TemplateSummary[];
  pagination?: Pagination;
}

/** Body for POST /api/v1/templates (create) and PUT /api/v1/templates/{id}. */
export interface TemplateCreate {
  name: string;
  markdown: string;
  description?: string;
  category?: string;
  tags?: string[];
  expiry_days?: number;
  [key: string]: unknown;
}

export interface Webhook {
  id: string;
  url: string;
  /** `whsec_…` signing secret — returned in full only at creation time. */
  secret?: string;
  events: string[];
  active: boolean;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  webhook_id: string;
  envelope_id?: string | null;
  event: string;
  url: string;
  status: string;
  attempt: number;
  max_attempts: number;
  response_code?: number | null;
  duration_ms?: number | null;
  error?: string | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor?: string;
  signer_id?: string | null;
  ip_address?: string | null;
  metadata?: Record<string, unknown> | null;
  entry_hash: string;
  previous_hash?: string | null;
  created_at: string;
}

export interface AuditTrail {
  envelope_id: string;
  chain_valid: boolean;
  chain_errors: string[];
  event_count: number;
  events: AuditEvent[];
}

export interface EvidenceChecklist {
  complete: boolean;
  checklist: Record<string, unknown>;
}

export interface VerifyResult {
  verified: boolean;
  envelope?: {
    id: string;
    status: string;
    template_id?: string;
    sender_name?: string;
    sender_email?: string;
    created_at?: string;
    completed_at?: string;
    retention_years?: number;
  };
  template?: { name?: string };
  verify_id?: string;
  lookup_method?: string;
  signers?: Array<Record<string, unknown>>;
  audit_trail?: Array<Record<string, unknown>>;
  integrity?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Shape thrown by the client on any non-2xx response. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  request_id?: string;
}
