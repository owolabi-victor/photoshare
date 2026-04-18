# Photoshare — Scalable Photo Sharing API

A production-grade photo sharing backend built to demonstrate the complete evolution of a system from a single server monolith to a globally distributed architecture. 

---

## Architecture Evolution

This project was built in 9 phases, each solving a real scalability problem introduced by the previous phase.

### Phase 1 — The Monolith
Single Node.js server with MariaDB on the same machine. Simple, fast to build, single point of failure.

### Phase 2 — Separated Tiers
Database moved to a dedicated server (Docker container). Web tier and data tier now have independent resources. Connection uses environment-driven config so no application code changed.

### Phase 3 — Horizontal Scaling with Load Balancer
NGINX load balancer distributes traffic across two Node.js instances using round robin. If one instance dies, NGINX automatically routes all traffic to the surviving instance. Zero downtime failover proven in testing.

### Phase 4 — Database Replication
Master-slave replication between two MariaDB instances. All writes go to the master. All reads are distributed to the slave. Read/write splitting implemented at the application layer — every SQL query is deliberately routed based on its type.

### Phase 5 — Cache and CDN
Redis cache sits between the application and database. Feed requests are cached with a 30-second TTL. Cache is invalidated immediately on photo upload. NGINX serves static files directly from disk with 7-day `Cache-Control` headers, bypassing Node.js entirely for photo delivery.

### Phase 6 — Stateless Web Tier
Session data moved from the database to Redis. Every request authenticates in under 1ms via Redis lookup. Shared rate limiting across all instances using Redis atomic counters — 5 failed login attempts triggers a 15-minute lockout, enforced consistently regardless of which server handles the request.

### Phase 7 — Asynchronous Processing
RabbitMQ message queue decouples photo upload from photo processing. Upload endpoint returns immediately after saving the file. A background worker consumes jobs from the queue and resizes each photo into thumbnail (200×200) and medium (800×800) variants using Sharp. Jobs are durable and survive restarts. Failed jobs are automatically requeued.

### Phase 8 — Database Sharding
User data is distributed across two independent database shards using hash-based routing: `user_id % num_shards`. User-specific queries hit a single shard. Global queries (feed) fan out across all shards simultaneously using `Promise.all` and merge results in memory. Cross-shard uniqueness enforced at the application layer.

### Phase 9 — Global Scale
Two simulated data centers (US East, EU West) each with their own NGINX and Node.js instances, both connecting to shared database shards. Structured JSON logging on every request includes timestamp, region, instance, method, path, status, and duration. Health check endpoint at `/health` reports region and instance status for load balancer and GeoDNS integration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18 |
| Framework | Express.js |
| Database | MariaDB 10.6 |
| Cache | Redis 7 |
| Message Queue | RabbitMQ 3 |
| Image Processing | Sharp |
| Reverse Proxy / Load Balancer | NGINX |
| Containerisation | Docker + Docker Compose |
| Authentication | UUID session tokens + bcrypt |

---

## Project Structure

```
photoshare/
├── server.js           # Entry point, structured logging, health check
├── db.js               # Database connection pools
├── redis.js            # Redis connection
├── shardRouter.js      # Shard routing logic
├── worker.js           # RabbitMQ consumer, image resizing
├── routes/
│   ├── auth.js         # Register, login, logout
│   └── photos.js       # Upload, feed, my-photos
├── middleware/
│   └── auth.js         # Session validation with Redis cache
├── mysql-config/
│   ├── master.cnf      # Binary log config for replication master
│   └── slave.cnf       # Read-only config for replication slave
├── nginx.conf          # Single region NGINX config
├── nginx-us.conf       # US data center NGINX config
├── nginx-eu.conf       # EU data center NGINX config
├── docker-compose.yml  # Full multi-region infrastructure
└── Dockerfile          # Node.js Alpine image
```

---

## API Endpoints

### Auth
| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| POST | `/auth/register` | Register a new user | No |
| POST | `/auth/login` | Login and receive session token | No |
| POST | `/auth/logout` | Invalidate session token | Yes |

### Photos
| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| POST | `/photos/upload` | Upload a photo (multipart/form-data) | Yes |
| GET | `/photos/feed` | Get all photos, newest first | Yes |
| GET | `/photos/my-photos` | Get photos for authenticated user | Yes |

### System
| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Basic health check with region and instance |
| GET | `/health` | Detailed health check for load balancers |

---

## Running Locally

### Prerequisites
- Docker and Docker Compose
- Node.js 18+

### Start the full stack

```bash
git clone https://github.com/owolabi-victor/photoshare.git
cd photoshare
npm install
docker-compose up --build
```

### Create database tables on both shards

```bash
docker exec -it photoshare-db-shard0 mariadb -u photoshare_user -pphotoshare_password photoshare
```

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE photos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  caption TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Repeat for `photoshare-db-shard1`.

### Data center endpoints

| Region | URL |
|---|---|
| US East | http://localhost:8080 |
| EU West | http://localhost:8081 |
| RabbitMQ UI | http://localhost:15672 (admin/password) |

---

## Key Design Decisions

**Parameterised queries everywhere** — all SQL uses `?` placeholders to prevent SQL injection. Raw string interpolation in queries is never used.

**Passwords never stored in plain text** — bcrypt with 10 salt rounds. Even if the database is compromised, passwords cannot be reversed.

**Tokens over JWTs** — session tokens stored in Redis give instant revocation. A logout immediately invalidates the session across all instances with no token expiry window.

**Cache-aside pattern** — Redis is always checked before the database. On a miss, the database result is stored in Redis for subsequent requests. Cache is invalidated surgically on writes rather than waiting for TTL expiry.

**Shared rate limiting** — login attempt counters live in Redis, not server memory. An attacker cannot bypass limits by hitting different instances.

**Worker acknowledgements** — RabbitMQ jobs are only removed from the queue after the worker explicitly acknowledges completion. A crashed worker causes the job to be requeued automatically.

**NGINX serves static files** — photo files are served directly by NGINX from the shared volume. Node.js is never in the path of static file delivery.

**Shard routing by user_id** — all data for a user (profile, photos, sessions) lives on the same shard. User-specific queries never need cross-shard joins.

---

## Environment Variables

```
DB_SHARD0_HOST      Host for database shard 0
DB_SHARD1_HOST      Host for database shard 1
DB_USER             Database username
DB_PASSWORD         Database password
DB_NAME             Database name
SESSION_SECRET      Secret for session signing
PORT                Application port
REGION              Data center region label (us-east, eu-west)
REDIS_HOST          Redis host
REDIS_PORT          Redis port
RABBITMQ_URL        RabbitMQ AMQP connection string
```

---

## What This Project Demonstrates

- Horizontal scaling and high availability with NGINX load balancing
- Database replication with read/write splitting at the application layer
- Cache-aside pattern with Redis and TTL-based expiry
- Cache invalidation on write operations
- Stateless authentication using shared session store
- Distributed rate limiting using atomic Redis operations
- Asynchronous job processing with guaranteed delivery
- Hash-based database sharding with application-layer routing
- Fan-out queries across multiple shards with in-memory merge
- Multi-region deployment with structured observability
- Production-grade security: parameterised queries, bcrypt, token revocation

---

