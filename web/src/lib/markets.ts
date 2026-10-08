// Markets (docs/RTD_MARKETS.md): what vendors see, what the organiser shows,
// and shrinking photos in the browser before they're sent.

export interface PublicMarket {
  market_id: string;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  /** "Free", "£15" */
  pitch_fee: string;
  pitches: number;
  pitches_left: number;
  applications_close: string;
  /** Taking applications (once full, they join the waiting list). */
  open: boolean;
  /** Its date in the diary, once the Logic Engine has it. */
  occurrence_id: string | null;
}

export interface StaffMarket {
  market_id: string;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  pitches: number;
  pitch_fee_pence: number;
  pitch_fee: string;
  applications_close: string;
  payment_details: string;
  status: 'scheduled' | 'published';
  event_id: string | null;
  pending: number;
  approved: number;
}

export interface VendorApplication {
  application_id: string;
  market_id: string;
  stall_name: string;
  contact_name: string;
  email: string;
  mobile: string;
  products: string;
  links: string | null;
  insured: boolean;
  insurer: string | null;
  insurance_expiry: string | null;
  insurance_lapses: boolean;
  notes: string | null;
  photo_count: number;
  photos: string[];
  waitlisted: boolean;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export const MAX_PHOTOS = 3;
const LONGEST_SIDE = 1600;

/**
 * A photo as a JPEG data URL, at most 1600px on its longest side. Re-drawing it
 * also drops its hidden details (like where it was taken). null: it couldn't be read.
 */
export async function shrinkPhoto(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/** A typed link, if it's a web address. Anything else is shown as text. */
export function webLink(text: string): string | null {
  const t = text.trim();
  const url = /^https?:\/\//i.test(t) ? t : /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) ? `https://${t}` : null;
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
