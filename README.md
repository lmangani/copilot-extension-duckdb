<img src="https://github.com/user-attachments/assets/46a5c546-7e9b-42c7-87f4-bc8defe674e0" width=250 />

# DuckDB Copilot Extension

Experimental extension to run DuckDB as a Copilot Extension helper

![image](https://github.com/user-attachments/assets/16575c08-4325-4c17-b1a5-cef4de44abd0)


## Installation

Run the following commands to install and start the application locally

```
npm install
npm run dev
open http://localhost:3000
```

> Follow the `/docs` instructions to [register](https://github.com/quackscience/copilot-extension-duckdb/blob/main/docs/DEVELOPMENT_SETUP.md) your Copilot Extension

## Examples
### Basic Queries
```sql
@duckdb-copilot SELECT 1, 2, 3
```

### Table Persistence
```sql
@duckdb-copilot CREATE TABLE cities (
    name VARCHAR,
    country VARCHAR
);
```

```sql
@duckdb-copilot INSERT INTO cities
VALUES ('San Francisco', 'US'), ('Amsterdam','NL'), ('Bologna','IT');
```

```sql
@duckdb-copilot SELECT * FROM cities
```

### LLM SQL
```
@duckdb-copilot show all entries from cities
```

```
@duckdb-copilot show the duckdb version
```
