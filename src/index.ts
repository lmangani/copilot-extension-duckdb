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
import { Readable } from "node:stream";

// Initialize DuckDB
const db = new duckdb.Database(':memory:'); // In-memory database
const connection = db.connect();

// Helper function to execute SQL queries, return JSON
async function executeQuery(query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) reject(err);
      else {
        const chunks = ['```json\n', result, '\n', '```\n'];
        resolve(chunks);
      }
    });
  });
}

// Helper function to execute SQL queries, return markdown table
async function executeQueryTable(query: string, customConnection?: any): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const conn = customConnection || connection;
    conn.all(query, (err, result) => {
      if (err) {
        reject(err);
      } else {
        // Build response chunks
        const chunks = [];
        if (result.length > 0) {
          const headers = Object.keys(result[0]);
          chunks.push('| ' + headers.join(' | ') + ' |\n');
          chunks.push('| ' + headers.map(() => '---').join(' | ') + ' |\n');
          result.forEach(row => {
            const values = headers.map(header => row[header]);
            chunks.push('| ' + values.join(' | ') + ' |\n');
          });
          chunks.push('\n');
        } else {
          chunks.push('No results found.\n');
        }
        resolve(chunks);
      }
    });
  });
}

// Dummy helper to be extended later on
function containsSQLQuery(message: string): boolean {
  const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'LIMIT', 'ATTACH'];
  const upperMessage = message.toUpperCase();
  return sqlKeywords.some(keyword => upperMessage.includes(keyword));
}

const app = new Hono();

app.get("/", (c) => {
  return c.text("Quack! Welcome to the Copilot DuckDB Extension! 👋");
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
      console.log("User:", user.data.login);
      console.log("Request:", userPrompt);
      
      // Patch LLM
      const messages = payload.messages;
      messages.unshift({
        role: "system",
        content: `You exclusively return complete, valid DuckDB SQL queries without any commentary. Always end queries with semicolon. You're specialized in DuckDB's unique SQL features and syntax.

        Examples:
        User: show the duckdb version
        Assistant: SELECT version();
        
        User: Show me records from data
        Assistant: SELECT * FROM data;
        
        User: Select all records from 'https://duckdb.org/data/schedule.csv'
        Assistant: SELECT * FROM 'https://duckdb.org/data/schedule.csv'
        
        User: Show all airports in Italy from 'https://s3.us-east-1.amazonaws.com/altinity-clickhouse-data/airline/data/airports/Airports.csv'
        Assistant: SELECT * FROM read_csv_auto("https://s3.us-east-1.amazonaws.com/altinity-clickhouse-data/airline/data/airports/Airports.csv") WHERE Country == 'Italy' ORDER BY City ASC
        
        User: Show file info
        Assistant: SELECT * FROM duckdb_extensions();`
      });
    
      // Use Copilot's LLM to generate a response to the user's messages, with
      // our extra system messages attached.
      const copilotLLMResponse = await fetch(
        "https://api.githubcopilot.com/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenForUser}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messages,
            stream: true,
          }),
        }
      );

      try {
          const newquery = await processLLMStream(copilotLLMResponse.body);
          console.log("LLM Response:", newquery);
      } catch (error) {
          console.error('Error converting stream to string:', error);
          return c.text('Error processing LLM stream:', error);
      }
      
      // Check if the message contains a SQL query
      if (containsSQLQuery(newquery)) {
        // Custom DB Instance for the authorized user. Not persistent long-term unless a volume is mapped.
        console.log('Found valid query:',newquery);
        const userdb = new duckdb.Database(`/tmp/${user.data.login}`);
        const userconnection = userdb.connect();
        try {
          if (['(FORMAT JSON)'].some(char => userPrompt.toLowerCase().endsWith(char))) {
            const resultChunks = await executeQuery(newquery.replace('(FORMAT JSON)',''), userconnection);
          } else {
            const resultChunks = await executeQueryTable(newquery, userconnection);
          }
          // stream.write(createTextEvent(`Hi ${user.data.login}! Here are your query results:\n`));
          for (const chunk of resultChunks) {
            stream.write(createTextEvent(chunk));
          }
        } catch (error) {
          stream.write(createTextEvent(`Oops! There was an error executing your query:\n`));
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

/**
 * Processes a stream of Server-Sent Events from the Copilot LLM API
 * and accumulates the content into a single string
 */
async function processLLMStream(stream: ReadableStream): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let accumulator = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Decode the chunk
            const chunk = decoder.decode(value);
            
            // Split into individual SSE events
            const events = chunk
                .split('\n')
                .filter(line => line.startsWith('data: '))
                .map(line => line.slice(5).trim());

            // Process each event
            for (const event of events) {
                if (event === '[DONE]') continue;
                
                try {
                    const parsed = JSON.parse(event);
                    if (parsed.choices?.[0]?.delta?.content) {
                        accumulator += parsed.choices[0].delta.content;
                    }
                } catch (e) {
                    // Skip invalid JSON
                    continue;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    return accumulator.trim();
}

const port = 3000;
console.log(`DuckDB-Copilot Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
