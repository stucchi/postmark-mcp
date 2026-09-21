/**
 * @file Postmark MCP Server
 * @description Official Postmark MCP server for sending emails via Claude and AI assistants
 * @author Jabal Torres
 * @license MIT
 */

import 'dotenv/config';
import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postmark from "postmark";

// Single source of truth for the server version (also published in package.json / server.json)
const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

const serverToken = process.env.POSTMARK_SERVER_TOKEN;
const defaultSender = process.env.DEFAULT_SENDER_EMAIL;
const defaultMessageStream = process.env.DEFAULT_MESSAGE_STREAM;

// Drop undefined keys so the SDK only sends filters the caller actually provided.
function buildFilter(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

// Initialize Postmark client and MCP server
async function initializeServices() {
  try {
    if (!serverToken) {
      console.error('[ERROR] POSTMARK_SERVER_TOKEN is not set');
      process.exit(1);
    }

    if (!defaultSender) {
      console.error('[ERROR] DEFAULT_SENDER_EMAIL is not set');
      process.exit(1);
    }

    if (!defaultMessageStream) {
      console.error('[ERROR] DEFAULT_MESSAGE_STREAM is not set');
      process.exit(1);
    }

    console.error('Initializing Postmark MCP server..');
    console.error('Default sender: ', defaultSender);
    console.error('Message stream: ', defaultMessageStream);

    const client = new postmark.ServerClient(serverToken);
    
    // Verify Postmark client by making a test API call
    await client.getServer();

    const mcpServer = new McpServer({
      name: "postmark-mcp",
      version: SERVER_VERSION
    });

    return { postmarkClient: client, mcpServer };
  } catch (error) {
    if (error.code || error.message) {
      throw new Error(`Initialization failed: ${error.code ? `${error.code} - ` : ''}${error.message}`);
    }

    throw new Error('Initialization failed: An unexpected error occurred');
  }
}

// Start the server
async function main() {
  try {
    const { postmarkClient, mcpServer: server } = await initializeServices();

    registerTools(server, postmarkClient);

    console.error('Connecting to MCP transport..');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('Postmark MCP server is running and ready!');
    console.error(`Available tools: sendEmail, sendEmailWithTemplate, listTemplates, getDeliveryStats, getBounces, getBounce, activateBounce, getSuppressions, createSuppressions, deleteSuppressions, getBounceStats, getSpamStats`);

    process.on('SIGTERM', () => handleShutdown(server));
    process.on('SIGINT', () => handleShutdown(server));
  } catch (error) {
    console.error('Server initialization failed: ', error.message);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function handleShutdown(server) {
  console.error('Shutting down server..');

  try {
    await server.close();
    console.error('Server shutdown complete. Bye! 👋');
    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Shutdown: ', error.message);
    process.exit(1);
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception: ', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection: ', reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

// Move tool registration to a separate function for better organization
function registerTools(server, postmarkClient) {
  // Define and register the sendEmail tool
  server.tool(
    "sendEmail",
    {
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      textBody: z.string().describe("Plain text body of the email"),
      htmlBody: z.string().optional().describe("HTML body of the email (optional)"),
      from: z.string().email().optional().describe("Sender email address (optional, uses default if not provided)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    {
      title: "Send Email",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ to, subject, textBody, htmlBody, from, tag }) => {
      const emailData = {
        From: from || defaultSender,
        To: to,
        Subject: subject,
        TextBody: textBody,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (htmlBody) emailData.HtmlBody = htmlBody;
      if (tag) emailData.Tag = tag;

      console.error('Sending email..', { to, subject });
      const result = await postmarkClient.sendEmail(emailData);
      console.error('Email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nSubject: ${subject}`
        }]
      };
    }
  );

  // Define and register the sendEmailWithTemplate tool
  server.tool(
    "sendEmailWithTemplate",
    {
      to: z.string().email().describe("Recipient email address"),
      templateId: z.number().optional().describe("Template ID (use either this or templateAlias)"),
      templateAlias: z.string().optional().describe("Template alias (use either this or templateId)"),
      templateModel: z.object({}).passthrough().describe("Data model for template variables"),
      from: z.string().email().optional().describe("Sender email address (optional)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    {
      title: "Send Email With Template",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ to, templateId, templateAlias, templateModel, from, tag }) => {
      if (!templateId && !templateAlias) {
        throw new Error("Either templateId or templateAlias must be provided");
      }

      const emailData = {
        From: from || defaultSender,
        To: to,
        TemplateModel: templateModel,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (templateId) {
        emailData.TemplateId = templateId;
      } else {
        emailData.TemplateAlias = templateAlias;
      }

      if (tag) emailData.Tag = tag;

      console.error('Sending template email..', { to, templateId: templateId || templateAlias });
      const result = await postmarkClient.sendEmailWithTemplate(emailData);
      console.error('Template email sent successfully: ', result.MessageID);
      
      return {
        content: [{
          type: "text", 
          text: `Template email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nTemplate: ${templateId || templateAlias}`
        }]
      };
    }
  );

  // Define and register the listTemplates tool
  server.tool(
    "listTemplates",
    {},
    {
      title: "List Templates",
      readOnlyHint: true,
      openWorldHint: true
    },
    async () => {
      console.error('Fetching templates..');
      const result = await postmarkClient.getTemplates();
      console.error(`Found ${result.Templates.length} templates`);

      const templateList = result.Templates.map(t => 
        `• **${t.Name}**\n  - ID: ${t.TemplateId}\n  - Alias: ${t.Alias || 'none'}\n  - Subject: ${t.Subject || 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Templates.length} templates:\n\n${templateList}`
        }]
      };
    }
  );

  // Define and register the getDeliveryStats tool
  server.tool(
    "getDeliveryStats",
    {
      tag: z.string().optional().describe("Filter by tag (optional)"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format (optional)"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format (optional)")
    },
    {
      title: "Get Delivery Stats",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ tag, fromDate, toDate }) => {
      console.error('Fetching delivery stats..');

      const data = await postmarkClient.getOutboundOverview(buildFilter({ tag, fromDate, toDate }));
      console.error('Stats retrieved successfully');

      const sent = data.Sent || 0;
      const tracked = data.Tracked || 0;
      const uniqueOpens = data.UniqueOpens || 0;
      const totalTrackedLinks = data.TotalTrackedLinksSent || 0;
      const uniqueLinksClicked = data.UniqueLinksClicked || 0;
      const openRate = tracked > 0 ? ((uniqueOpens / tracked) * 100).toFixed(1) : '0.0';
      const clickRate = totalTrackedLinks > 0 ? ((uniqueLinksClicked / totalTrackedLinks) * 100).toFixed(1) : '0.0';

      return {
        content: [{
          type: "text",
          text: `Email Statistics Summary\n\n` +
                `Sent: ${sent} emails\n` +
                `Open Rate: ${openRate}% (${uniqueOpens}/${tracked} tracked emails)\n` +
                `Click Rate: ${clickRate}% (${uniqueLinksClicked}/${totalTrackedLinks} tracked links)\n\n` +
                `${fromDate || toDate ? `Period: ${fromDate || 'start'} to ${toDate || 'now'}\n` : ''}` +
                `${tag ? `Tag: ${tag}\n` : ''}`
        }]
      };
    }
  );

  // Define and register the getBounces tool
  server.tool(
    "getBounces",
    {
      count: z.number().min(1).max(500).optional().describe("Number of bounces to return (1-500, default 25)"),
      offset: z.number().optional().describe("Number of bounces to skip (default 0)"),
      type: z.string().optional().describe("Filter by bounce type (e.g. HardBounce, SoftBounce, SpamNotification, Transient)"),
      inactive: z.boolean().optional().describe("Filter by inactive/active status"),
      emailFilter: z.string().optional().describe("Filter by email address (partial match)"),
      tag: z.string().optional().describe("Filter by tag"),
      messageID: z.string().optional().describe("Filter by message ID"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      messageStream: z.string().optional().describe("Filter by message stream (default: all streams)")
    },
    {
      title: "Get Bounces",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ count, offset, type, inactive, emailFilter, tag, messageID, fromDate, toDate, messageStream }) => {
      console.error('Fetching bounces..');

      const data = await postmarkClient.getBounces(buildFilter({
        count: count ?? 25,
        offset: offset ?? 0,
        type,
        inactive,
        emailFilter,
        tag,
        messageID,
        fromDate,
        toDate,
        messageStream
      }));
      console.error(`Found ${data.TotalCount} bounces`);

      const bounceList = data.Bounces.map(b =>
        `• **${b.Email}**\n  - Type: ${b.Type}\n  - Description: ${b.Description || 'none'}\n  - Date: ${b.BouncedAt}\n  - Inactive: ${b.Inactive}\n  - ID: ${b.ID}\n  - MessageStream: ${b.MessageStream || 'default'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${data.TotalCount} bounces (showing ${data.Bounces.length}):\n\n${bounceList}`
        }]
      };
    }
  );

  // Define and register the getBounce tool
  server.tool(
    "getBounce",
    {
      bounceId: z.number().describe("The bounce ID to retrieve")
    },
    {
      title: "Get Bounce",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ bounceId }) => {
      console.error('Fetching bounce details..', { bounceId });

      const b = await postmarkClient.getBounce(bounceId);
      console.error('Bounce details retrieved');

      return {
        content: [{
          type: "text",
          text: `Bounce Details\n\n` +
                `Email: ${b.Email}\n` +
                `Type: ${b.Type}\n` +
                `Description: ${b.Description || 'none'}\n` +
                `Details: ${b.Details || 'none'}\n` +
                `Date: ${b.BouncedAt}\n` +
                `Inactive: ${b.Inactive}\n` +
                `Can Activate: ${b.CanActivate}\n` +
                `ID: ${b.ID}\n` +
                `MessageStream: ${b.MessageStream || 'default'}\n` +
                `Subject: ${b.Subject || 'none'}\n` +
                `ServerID: ${b.ServerID}`
        }]
      };
    }
  );

  // Define and register the activateBounce tool (reactivate a blocked recipient)
  server.tool(
    "activateBounce",
    {
      bounceId: z.number().describe("The bounce ID to activate/unblock")
    },
    {
      title: "Activate Bounce",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ bounceId }) => {
      console.error('Activating bounce..', { bounceId });

      const data = await postmarkClient.activateBounce(bounceId);
      console.error('Bounce activated successfully');

      return {
        content: [{
          type: "text",
          text: `Bounce activated successfully!\n\n` +
                `Message: ${data.Message}\n` +
                `Email: ${data.Bounce.Email}\n` +
                `ID: ${data.Bounce.ID}\n` +
                `Inactive: ${data.Bounce.Inactive}`
        }]
      };
    }
  );

  // Define and register the getSuppressions tool
  server.tool(
    "getSuppressions",
    {
      messageStream: z.string().optional().describe("Message stream ID (default: outbound)"),
      suppressionReason: z.string().optional().describe("Filter by reason: ManualSuppression, HardBounce, SpamComplaint"),
      origin: z.string().optional().describe("Filter by origin: Recipient, Customer, Admin"),
      emailAddress: z.string().optional().describe("Filter by email address")
    },
    {
      title: "Get Suppressions",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ messageStream, suppressionReason, origin, emailAddress }) => {
      const stream = messageStream || 'outbound';
      console.error('Fetching suppressions..', { stream });

      const data = await postmarkClient.getSuppressions(stream, buildFilter({ suppressionReason, origin, emailAddress }));
      const suppressions = data.Suppressions || [];
      console.error(`Found ${suppressions.length} suppressions`);

      const list = suppressions.map(s =>
        `• **${s.EmailAddress}**\n  - Reason: ${s.SuppressionReason}\n  - Origin: ${s.Origin}\n  - Created: ${s.CreatedAt}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${suppressions.length} suppressions in stream "${stream}":\n\n${list || 'No suppressions found.'}`
        }]
      };
    }
  );

  // Define and register the createSuppressions tool
  server.tool(
    "createSuppressions",
    {
      messageStream: z.string().optional().describe("Message stream ID (default: outbound)"),
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("List of email addresses to suppress (1-50)")
    },
    {
      title: "Create Suppressions",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ messageStream, emailAddresses }) => {
      const stream = messageStream || 'outbound';
      console.error('Creating suppressions..', { stream, count: emailAddresses.length });

      const data = await postmarkClient.createSuppressions(stream, {
        Suppressions: emailAddresses.map(e => ({ EmailAddress: e }))
      });
      const results = data.Suppressions || [];
      console.error('Suppressions created');

      const list = results.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ' - ' + s.Message : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Suppression results:\n\n${list}`
        }]
      };
    }
  );

  // Define and register the deleteSuppressions tool (unblock suppressed addresses)
  server.tool(
    "deleteSuppressions",
    {
      messageStream: z.string().optional().describe("Message stream ID (default: outbound)"),
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("List of email addresses to unsuppress/unblock (1-50)")
    },
    {
      title: "Delete Suppressions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ messageStream, emailAddresses }) => {
      const stream = messageStream || 'outbound';
      console.error('Deleting suppressions..', { stream, count: emailAddresses.length });

      const data = await postmarkClient.deleteSuppressions(stream, {
        Suppressions: emailAddresses.map(e => ({ EmailAddress: e }))
      });
      const results = data.Suppressions || [];
      console.error('Suppressions deleted');

      const list = results.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ' - ' + s.Message : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Unsuppression results:\n\n${list}`
        }]
      };
    }
  );

  // Define and register the getBounceStats tool
  server.tool(
    "getBounceStats",
    {
      tag: z.string().optional().describe("Filter by tag (optional)"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format")
    },
    {
      title: "Get Bounce Stats",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ tag, fromDate, toDate }) => {
      console.error('Fetching bounce stats..');

      const data = await postmarkClient.getBounceCounts(buildFilter({ tag, fromDate, toDate }));
      console.error('Bounce stats retrieved');

      const days = (data.Days || []).map(d =>
        `  ${d.Date}: Hard=${d.HardBounce || 0}, Soft=${d.SoftBounce || 0}, Transient=${d.Transient || 0}, SMTPApiError=${d.SMTPApiError || 0}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Bounce Statistics\n\n` +
                `${fromDate || toDate ? `Period: ${fromDate || 'start'} to ${toDate || 'now'}\n` : ''}` +
                `${tag ? `Tag: ${tag}\n` : ''}\n` +
                `Daily breakdown:\n${days || 'No data available.'}`
        }]
      };
    }
  );

  // Define and register the getSpamStats tool
  server.tool(
    "getSpamStats",
    {
      tag: z.string().optional().describe("Filter by tag (optional)"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format")
    },
    {
      title: "Get Spam Stats",
      readOnlyHint: true,
      openWorldHint: true
    },
    async ({ tag, fromDate, toDate }) => {
      console.error('Fetching spam complaint stats..');

      const data = await postmarkClient.getSpamComplaintsCounts(buildFilter({ tag, fromDate, toDate }));
      console.error('Spam stats retrieved');

      const days = (data.Days || []).map(d =>
        `  ${d.Date}: SpamComplaint=${d.SpamComplaint || 0}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Spam Complaint Statistics\n\n` +
                `${fromDate || toDate ? `Period: ${fromDate || 'start'} to ${toDate || 'now'}\n` : ''}` +
                `${tag ? `Tag: ${tag}\n` : ''}\n` +
                `Daily breakdown:\n${days || 'No data available.'}`
        }]
      };
    }
  );
}

main().catch((error) => {
  console.error('[ERROR] Failed to start server: ', error.message);
  process.exit(1);
});