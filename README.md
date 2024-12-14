<img src="https://github.com/user-attachments/assets/46a5c546-7e9b-42c7-87f4-bc8defe674e0" width=250 />

# DuckDB Copilot Extension

Experimental extension to run DuckDB as a Copilot Extension helper

## Installation

Run the following commands to install and start the application locally

```
npm install
npm run dev
open http://localhost:3000
```

> Follow the `/docs` instructions to register your Copilot Extension

## Examples
### Basic Queries
```
@duckdb-copilot SELECT 1, 2, 3
```

### Table Persistence
```
@duckdb-copilot CREATE TABLE cities (
    name VARCHAR,
    country VARCHAR
);
```

```
@duckdb-copilot INSERT INTO cities
VALUES ('San Francisco', 'US'), ('Amsterdam','NL'), ('Bologna','IT');
```

```
@duckdb-copilot SELECT * FROM cities
```

### LLM SQL
```
@duckdb-copilot show all entries from cities
```

```
@duckdb-copilot show the duckdb version
```
