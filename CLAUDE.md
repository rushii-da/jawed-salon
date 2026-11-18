# Jawed Salon OS

Node 22+ native SQLite (`node:sqlite`) Salon Owner Operating System with Counter POS, Indian GST Invoicing, Live Chair Queue, Client 360° CRM, and WhatsApp Opt-In Queue.

## Deploy Configuration (configured by /setup-deploy)
- Platform: Render
- Production URL: https://jawed-salon.onrender.com
- Deploy workflow: auto-deploy on push
- Deploy status command: HTTP health check
- Merge method: squash
- Project type: web app
- Post-deploy health check: https://jawed-salon.onrender.com/api/health

### Custom deploy hooks
- Pre-merge: npm test
- Deploy trigger: automatic on push to main
- Deploy status: HTTP health check
- Health check: https://jawed-salon.onrender.com/api/health
