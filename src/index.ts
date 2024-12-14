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
      else resolve(result);
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

// Dummy helper to filter out non-queries
function containsSQLQuery(message: string): boolean {
  const duckdbPattern = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COPY|ATTACH|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|READ_CSV|READ_PARQUET|READ_JSON_AUTO|UNNEST|PRAGMA|EXPLAIN|DESCRIBE|SHOW|SET|WITH|CASE|JOIN|TABLE)\b/i;
  return duckdbPattern.test(message.toUpperCase());
}

const app = new Hono();

app.get("/", (c) => {
  return c.text("Quack! 👋");
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
      if (containsSQLQuery(userPrompt)) {
        console.log(user.data.login, userPrompt);
        try {
          const resultChunks = await executeQueryTable(userPrompt);
          console.log('Query Output:',resultChunks.join());
          // stream.write(createTextEvent(`Hi ${user.data.login}! Here are your query results:\n`));
          for (const chunk of resultChunks) {
            stream.write(createTextEvent(chunk));
          }
        } catch (error) {
          // not a query, lets work around it
          console.log(`Not a query! guessing via prompt.`);
          const { message } = await prompt(`You are a DuckDB SQL Expert. Return a DuckDB SQL query for this prompt. do not add any comments - only pure DuckDB SQL allowed: ${userPrompt}`, {
            token: tokenForUser,
          });
          const stripSQL = message.content.split('\n').filter(line => !line.trim().startsWith('```') && line.trim() !== '').join() || message.content;
          console.log('LLM Output:', stripSQL);
          if (containsSQLQuery(stripSQL)) {
            try {
              const resultChunks = await executeQueryTable(stripSQL);
              console.log('Query Output:', resultChunks.join());
              for (const chunk of resultChunks) {
                stream.write(createTextEvent(chunk));
              }
            } catch (error) {
               stream.write(createTextEvent(`Oops! ${error}`));
            }
          }
          
        }
      } else {
        // Handle non-SQL messages using the normal prompt flow
        console.log(`not a query. guessing via prompt.`);
        const { message } = await prompt(userPrompt, {
          token: tokenForUser,
        });
        console.log('LLM Output:', message.content);
        // If everything fails, return whatever the response was
        // stream.write(createTextEvent(`This doesn't look like DuckDB SQL.\n`));
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
