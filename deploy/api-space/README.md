---
title: AlumNet API
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

The AlumNet server: sign-in, profiles, mentorship requests, events,
opportunities, moderation and the admin tools, for the Kenya Airways alumni
mentorship portal (a Strathmore University capstone project).

This Space is updated automatically from the `main` branch of the AlumNet
GitHub repository by `.github/workflows/deploy.yml`, after the tests pass.
People use AlumNet through its Cloudflare address; this server only answers
requests that come through that gateway.
