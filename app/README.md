Main Next.js folder. Run locally with npm run dev or visit https://www.curriculize.org

The durable processor reads `CURRICULIZE_PROCESSOR_WORK_BUDGET_MS` as its invocation budget (default and maximum: 18,000 ms). It reserves up to 4 seconds for fenced cleanup and 6 seconds for the response, leaving 2 seconds below cron-job.org's confirmed 30-second request timeout. Do not raise this budget without rechecking the cron timeout and route platform limit.
