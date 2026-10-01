import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { to_email, email_type, template_vars } = await req.json();

    if (!to_email || !email_type) {
      return new Response(JSON.stringify({ error: "Missing required fields: to_email or email_type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY secret is not set in Supabase" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let subject = "";
    let htmlContent = "";

    const row = (label: string, value: string) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); color: #94a3b8; font-size: 14px;">${label}</td>
        <td style="padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); color: #f8fafc; font-size: 14px; font-weight: 600; text-align: right;">${value}</td>
      </tr>
    `;

    const wrapTemplate = (title: string, bodyText: string, contentTable: string = "", actionUrl: string = "", actionText: string = "") => {
      const buttonHtml = actionUrl ? `
        <div style="text-align: center; margin: 30px 0;">
          <a href="${actionUrl}" style="background-color: #1ab76d; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 15px; display: inline-block; box-shadow: 0 4px 12px rgba(26,183,109,0.3);">${actionText}</a>
        </div>
      ` : "";

      const tableHtml = contentTable ? `
        <div style="background-color: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 15px 20px; margin: 25px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            ${contentTable}
          </table>
        </div>
      ` : "";

      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head><body style="margin: 0; padding: 0; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; color: #f8fafc;"><table role="presentation" style="width: 100%; background-color: #0f172a; padding: 40px 20px;"><tr><td align="center"><table role="presentation" style="width: 100%; max-width: 580px; background-color: #1e293b; border-radius: 16px; border: 1px solid rgba(255,255,255,0.05); padding: 40px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); text-align: left;"><tr><td style="text-align: center; padding-bottom: 30px;"><div style="font-size: 24px; font-weight: 800; letter-spacing: 1px; color: #1ab76d;">GAIN EX <span style="color: #ffffff; font-weight: 400;">MARKET</span></div></td></tr><tr><td><h2 style="margin: 0 0 15px 0; font-size: 20px; font-weight: 700; color: #ffffff;">${title}</h2><div style="font-size: 15px; line-height: 1.6; color: #cbd5e1; margin-bottom: 20px;">${bodyText}</div>${tableHtml}${buttonHtml}</td></tr><tr><td style="border-top: 1px solid rgba(255,255,255,0.05); padding-top: 25px; margin-top: 30px; text-align: center; color: #64748b; font-size: 11px; line-height: 1.5;"><p style="margin: 0 0 10px 0;">This email is sent automatically by Gain EX Market Security System.</p><p style="margin: 0 0 10px 0;">If you did not request this email or have any security concerns, please contact our support team immediately.</p><p style="margin: 0;">&copy; 2026 Gain EX Market. All rights reserved.</p></td></tr></table></td></tr></table></body></html>`;
    };

    const vars = template_vars || {};
    const uName = vars.full_name || vars.username || "Trader";

    switch (email_type) {
      case "custom_email":
        subject = vars.subject || "Message from Gain EX Market";
        htmlContent = vars.html_content || wrapTemplate("Message from Gain EX Market", "You have a new message from Gain EX Market.");
        break;

      case "signup_success":
        subject = "Welcome to Gain EX Market! Verification Complete";
        htmlContent = wrapTemplate("Email Verified Successfully", `Hello ${uName},<br><br>Thank you for verifying your email address. Your account registration is now fully complete! You have gained access to all the trading platforms, real-time charts, and market indicators.<br><br>Start your trading journey by making a deposit or practicing with your demo account.`, "", "https://gainexmarket.com/login", "Login to Dashboard");
        break;

      case "kyc_submitted":
        subject = "KYC Documents Submitted Successfully";
        htmlContent = wrapTemplate("KYC Verification Pending", `Hello ${uName},<br><br>Your identity verification (KYC) documents have been received successfully. Our compliance team is currently reviewing your submission. You will receive an email update as soon as the review is complete (usually within 12-24 hours).`, row("Submitted By", uName) + row("Verification Status", "Pending Review") + row("Submitted Time", new Date().toLocaleString()));
        break;

      case "kyc_under_review":
        subject = "KYC Documents Under Review";
        htmlContent = wrapTemplate("KYC Review in Progress", `Hello ${uName},<br><br>We wanted to let you know that your identity verification documents are now actively under review by our compliance desk. No further action is required from your side at this moment.`);
        break;

      case "kyc_verified":
        subject = "KYC Verification Approved!";
        htmlContent = wrapTemplate("Account Verified Successfully", `Hello ${uName},<br><br>Congratulations! Your identity verification (KYC) has been fully approved by our security and compliance team. Your account limits have been updated, and you can now perform withdrawals and real-account trading without restrictions.`, row("Verification Status", "APPROVED") + row("Limit Level", "Full Unrestricted Access"), "https://gainexmarket.com/dashboard", "Go to Trading Desk");
        break;

      case "kyc_rejected":
        subject = "KYC Verification Rejected";
        const rejectReason = vars.reason || "The uploaded documents were unclear or did not match the profile details.";
        htmlContent = wrapTemplate("KYC Review Failed", `Hello ${uName},<br><br>Unfortunately, your identity verification (KYC) application was rejected. Please review the reason below and submit valid documents to verify your account.`, row("Verification Status", "REJECTED") + row("Rejection Reason", rejectReason), "https://gainexmarket.com/kyc", "Re-submit KYC Documents");
        break;

      case "deposit_created":
        subject = `Pending Deposit Request Created - $${vars.amount}`;
        htmlContent = wrapTemplate("Deposit Request Initiated", `Hello ${uName},<br><br>You have successfully initiated a pending deposit request. Please make the payment according to the selected method instructions. Once completed, our staff will verify and credit your account.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Method", vars.method || "N/A") + row("Amount Requested", `$${vars.amount} ${vars.currency || "USD"}`) + row("Status", "Pending Verification"));
        break;

      case "deposit_approved":
        subject = `Deposit Approved & Credited - $${vars.amount}`;
        htmlContent = wrapTemplate("Deposit Successfully Credited", `Hello ${uName},<br><br>Great news! Your deposit request has been approved and credited to your account balance. You can start trading on your Real Account immediately.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Amount Credited", `$${vars.amount} ${vars.currency || "USD"}`) + row("Status", "COMPLETED") + row("New Balance", `$${vars.new_balance || "N/A"}`), "https://gainexmarket.com/dashboard", "Start Trading");
        break;

      case "deposit_rejected":
        subject = `Deposit Request Rejected - $${vars.amount}`;
        const depReason = vars.reason || "Payment proof was missing, incorrect, or could not be verified.";
        htmlContent = wrapTemplate("Deposit Verification Failed", `Hello ${uName},<br><br>We were unable to verify your deposit request. The transaction has been rejected.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Amount", `$${vars.amount} ${vars.currency || "USD"}`) + row("Rejection Reason", depReason));
        break;

      case "withdrawal_code":
        subject = `${vars.code} is your Withdrawal Verification Code`;
        htmlContent = wrapTemplate("Withdrawal Security Code", `Hello ${uName},<br><br>You requested a verification code to authorize a withdrawal. Please enter the code below on the withdrawal page to submit your request.<br><br>This code is valid for **5 minutes** only. If you did not initiate this request, please secure your account immediately.`, `<tr><td colspan="2" style="text-align: center; padding: 20px 0;"><span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #1ab76d; background-color: rgba(26,183,109,0.1); border: 1px dashed #1ab76d; padding: 10px 25px; border-radius: 8px;">${vars.code}</span></td></tr>`);
        break;

      case "withdrawal_submitted":
        subject = `Withdrawal Request Received - $${vars.amount}`;
        htmlContent = wrapTemplate("Withdrawal Pending Approval", `Hello ${uName},<br><br>Your withdrawal request has been successfully submitted and is now pending review by our financial desk. Approvals are processed within 1 to 3 business hours.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Requested Amount", `$${vars.amount} ${vars.currency || "USD"}`) + row("Withdrawal Method", vars.method || "N/A") + row("Destination", vars.destination || "N/A") + row("Status", "Pending Review"));
        break;

      case "withdrawal_approved":
        subject = `Withdrawal Approved & Processed - $${vars.amount}`;
        htmlContent = wrapTemplate("Withdrawal Request Completed", `Hello ${uName},<br><br>Your withdrawal request has been approved and successfully processed. The funds have been sent to your designated destination.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Amount Sent", `$${vars.amount} ${vars.currency || "USD"}`) + row("Destination Wallet", vars.destination || "N/A") + row("Status", "SUCCESSFUL"));
        break;

      case "withdrawal_rejected":
        subject = `Withdrawal Request Rejected - $${vars.amount}`;
        const withReason = vars.reason || "Incorrect wallet address details or insufficient trading volume.";
        htmlContent = wrapTemplate("Withdrawal Request Denied", `Hello ${uName},<br><br>Your withdrawal request has been rejected by our compliance/financial desk. The funds have been refunded back to your account balance.`, row("Transaction ID", vars.transaction_id || "N/A") + row("Amount Refunded", `$${vars.amount} ${vars.currency || "USD"}`) + row("Rejection Reason", withReason));
        break;

      case "bonus_claim":
        subject = `Bonus Successfully Claimed - $${vars.amount}`;
        htmlContent = wrapTemplate("Promo Bonus Credited", `Hello ${uName},<br><br>You have successfully claimed a bonus on our platform! The bonus amount has been credited to your balance.`, row("Bonus Program", vars.bonus_name || "Promotion") + row("Bonus Amount", `$${vars.amount}`) + row("Description", vars.description || "N/A"));
        break;

      default:
        return new Response(JSON.stringify({ error: `Unsupported email_type: ${email_type}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: "Gain EX Market <noreply@gainexmarket.com>",
        to: [to_email],
        subject: subject,
        html: htmlContent,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      return new Response(JSON.stringify({ error: "Resend API Error", details: resendData }), {
        status: resendRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, message: "Email sent successfully", id: resendData.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
