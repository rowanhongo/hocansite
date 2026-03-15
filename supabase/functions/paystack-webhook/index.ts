// Paystack webhook handler: verify signature, update payments + orders.payment_status, create notification.
// No polling from website — payment status is updated only here.
// Return 200 immediately, then process (per Paystack recommendation).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function verifyPaystackSignature(payload: string, signature: string | null): Promise<boolean> {
  if (!PAYSTACK_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYSTACK_SECRET),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === signature;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const signature = req.headers.get("x-paystack-signature");
  const rawBody = await req.text();
  if (!rawBody) {
    return new Response(JSON.stringify({ error: "Empty body" }), { status: 400 });
  }

  if (!(await verifyPaystackSignature(rawBody, signature))) {
    console.error("Paystack webhook: invalid signature");
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let event: { event?: string; data?: { reference?: string; id?: number; amount?: number } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  if (event.event !== "charge.success") {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const reference = event.data?.reference;
  const eventId = event.data?.id != null ? String(event.data.id) : null;
  const amount = event.data?.amount ?? 0;

  if (!reference) {
    return new Response(JSON.stringify({ error: "Missing reference" }), { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (eventId) {
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("paystack_event_id", eventId)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
  }

  const { data: existingRef } = await supabase
    .from("payments")
    .select("id")
    .eq("paystack_reference", reference)
    .maybeSingle();
  if (existingRef) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
  }

  const { data: orderById } = await supabase
    .from("orders")
    .select("id, order_number")
    .eq("id", reference)
    .maybeSingle();
  const { data: orderByNumber } = await supabase
    .from("orders")
    .select("id, order_number")
    .eq("order_number", reference)
    .maybeSingle();
  const order = orderById ?? orderByNumber;
  if (!order) {
    console.error("Paystack webhook: order not found for reference", reference);
    return new Response(JSON.stringify({ received: true, error: "Order not found" }), { status: 200 });
  }
  const orderId = order.id;
  const orderNumber = order.order_number ?? reference;

  const { error: payErr } = await supabase.from("payments").insert({
    order_id: orderId,
    paystack_reference: reference,
    paystack_event_id: eventId,
    amount_cents: amount,
    status: "success",
    paid_at: new Date().toISOString(),
    raw_payload: event as unknown as object,
  });

  if (payErr) {
    console.error("Paystack webhook: payments insert error", payErr);
    return new Response(JSON.stringify({ received: true, error: "Insert failed" }), { status: 200 });
  }

  const { error: orderErr } = await supabase
    .from("orders")
    .update({ payment_status: "paid", updated_at: new Date().toISOString() })
    .eq("id", orderId);

  if (orderErr) {
    console.error("Paystack webhook: orders update error", orderErr);
  }

  const { data: admins } = await supabase.from("admins").select("user_id");
  if (admins?.length) {
    await supabase.from("notifications").insert(
      admins.map((a) => ({
        order_id: orderId,
        user_id: a.user_id,
        role: "admin",
        title: "Payment received",
        body: `Order ${orderNumber} has been paid.`,
        type: "payment_success",
      }))
    );
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
