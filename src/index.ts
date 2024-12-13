import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Octokit } from "@octokit/core";
import * as duckdb from 'duckdb';
import {
  createAckEvent,
  createDoneEvent,
  createErrorsEvent,
  createTextEvent,
  getUserMessage,
  prompt,
  verifyAndParseRequest,
} from "@copilot-extensions/preview-sdk";

// Initialize DuckDB
const db = new duckdb.Database(':memory:'); // In-memory database
const connection = db.connect();

// Helper function to execute SQL queries
async function executeQuery(query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Helper function to execute SQL queries
async function executeQueryTable(query: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) {
        reject(err);
      } else {
        // Print the SQL query within ```sql tags
        const chunks = ['```sql\n', query, ' \n', '```\n\n'];
        // Format the result into a markdown table
        chunks.push('```\n');
        if (result.length > 0) {
          const headers = Object.keys(result[0]);
          chunks.push('| ' + headers.join(' | ') + ' |\n');
          chunks.push('| ' + headers.map(() => '---').join(' | ') + ' |\n');
          result.forEach(row => {
            const values = headers.map(header => row[header]);
            chunks.push('| ' + values.join(' | ') + ' |\n');
          });
        } else {
          chunks.push('No results found.\n');
        }
        chunks.push('```\n');
        resolve(chunks);
      }
    });
  });
}

// Dummy helper to be extended later on
function containsSQLQuery(message: string): boolean {
  const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'LIMIT'];
  const upperMessage = message.toUpperCase();
  return sqlKeywords.some(keyword => upperMessage.includes(keyword));
}

const app = new Hono();

app.get("/", (c) => {
  return c.text("Welcome to the Copilot DuckDB Extension! Query Me! 👋");
});

app.post("/", async (c) => {
  const tokenForUser = c.req.header("X-GitHub-Token") ?? "";
  const body = await c.req.text();
  const signature = c.req.header("github-public-key-signature") ?? "";
  const keyID = c.req.header("github-public-key-identifier") ?? "";

  const { isValidRequest, payload } = await verifyAndParseRequest(
    body,
    signature,
    keyID,
    {
      token: tokenForUser,
    }
  );

  if (!isValidRequest) {
    console.error("Request verification failed");
    c.header("Content-Type", "text/plain");
    c.status(401);
    return c.text("Request could not be verified");
  }

  if (!tokenForUser) {
    return c.text(
      createErrorsEvent([
        {
          type: "agent",
          message: "No GitHub token provided in the request headers.",
          code: "MISSING_GITHUB_TOKEN",
          identifier: "missing_github_token",
        },
      ])
    );
  }

  c.header("Content-Type", "text/html");
  c.header("X-Content-Type-Options", "nosniff");

  return stream(c, async (stream) => {
    try {
      stream.write(createAckEvent());
      const octokit = new Octokit({ auth: tokenForUser });
      const user = await octokit.request("GET /user");
      const userPrompt = getUserMessage(payload);

      // Check if the message contains a SQL query
      if (containsSQLQuery(userPrompt)) {
        try {
          const resultChunks = await executeQueryTable(userPrompt);
          stream.write(createTextEvent(`Hi ${user.data.login}! Here are your query results:\n`));
          for (const chunk of resultChunks) {
            stream.write(createTextEvent(chunk));
          }
        } catch (error) {
          stream.write(createTextEvent(`Hi ${user.data.login}! There was an error executing your query:\n`));
          stream.write(createTextEvent(error instanceof Error ? error.message : 'Unknown error'));
        }
      } else {
        // Handle non-SQL messages using the normal prompt flow
        const { message } = await prompt(userPrompt, {
          token: tokenForUser,
        });
        stream.write(createTextEvent(`Hi ${user.data.login}! `));
        stream.write(createTextEvent(message.content));
      }

      stream.write(createDoneEvent());
    } catch (error) {
      stream.write(
        createErrorsEvent([
          {
            type: "agent",
            message: error instanceof Error ? error.message : "Unknown error",
            code: "PROCESSING_ERROR",
            identifier: "processing_error",
          },
        ])
      );
    }
  });
});

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
