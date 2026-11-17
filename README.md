# Jawed Salon · Owner Operating System

Full-featured Salon Owner Management Dashboard & Booking Engine with native SQLite persistence and 1-Click WhatsApp Client Confirmation.

## Features
- **Real-Time Revenue & Metrics**: Live daily earnings, ticket size, footfall, and payment splits in ₹ INR.
- **1-Click WhatsApp Confirmation**: Sends branded, pre-formatted appointment confirmations directly to client's WhatsApp.
- **Native SQLite Persistence**: Powered by Node 22+ `node:sqlite` with WAL mode and zero external dependencies.
- **Stylist Performance & Commissions**: Track appointments, average ticket size, and commission per stylist.
- **Client Retention / Win-back Engine**: Highlights inactive VIP clients and drafts WhatsApp re-engagement broadcasts.

## Local Development
```bash
node server.js
```
Open [http://localhost:3000](http://localhost:3000)

## Run Tests
```bash
npm test
```

## Deployment on Render.com (Recommended)
1. Push this repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com), click **New + ➔ Web Service**.
3. Connect your GitHub repository.
4. Settings:
   - **Environment**: `Node`
   - **Build Command**: *(leave empty)*
   - **Start Command**: `node server.js`
   - **Auto-Deploy**: `Yes`
5. Click **Create Web Service**. Your app will be live with free HTTPS SSL in ~60 seconds!
