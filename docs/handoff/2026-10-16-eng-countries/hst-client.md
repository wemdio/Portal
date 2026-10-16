# HST Solutions — ENG client (project 2971d740-1f5e-4eb9-a9e5-c04faaf8794c)

Status 2026-10-16: research finished 08:49 UTC with the OLD empty brief → 13 markets / 31 hypotheses, mostly NOT financial services, $1.88 recorded. Site read fine after the site-reader fix (6,591 chars, profile correct).
Nothing below has been written to production. Writing the fields, rejecting off-target hypotheses and re-running research (~$1.9, wipes verticals/bases) needs the owner's explicit «да» AND production access (only the local Mac session has SSH; the staff API also works if the cloud has an authenticated route — check before assuming).
Exact JSON payloads: `hst-staff-patch-body.json` (business/offer/signature via staff PATCH), `hst-icp.json` (brief.icp, write by SQL merge — the staff PATCH drops icp), `hst-cases-rows.json` (he_cases rows, source='upload').
Owner questions still open: keep the Blueprint Call in the offer (2,110-char variant) or not (1,821-char variant, `offer_override` in hst-offer-no-call.txt)? prototype price €24k vs €15k (brief contradicts itself)? Norway in scope? legal check for UK/EU sends without an opt-out line.
Owner decided: no file upload in the cabinet; no decision-maker title search; US East Coast filter not needed (whole US).

## Drafted field values (English, ready to write)

# HST — что впишем в проект (черновик, ещё не записано)

## Описание бизнеса (2 839 из 3 000 знаков)

HST Solutions is an Irish software engineering and AI company, founded in Dublin in 2007. We give financial services and other regulated businesses senior engineers who are productive from week one, backed by a full delivery pod: solutions architect, project manager and DevOps, all under one contract.

Most of our work is for fund administrators, asset managers, banks, insurers and insurtechs across Ireland, the UK, Europe and the US.

Our four practices:
Data and analytics engineering: data platform modernisation (SQL Server and SSIS to AWS or Azure data lakes), ETL and ELT pipelines, real time streaming (Kafka), data warehouses, Power BI and Tableau reporting, audit trails and data lineage.
Cloud and DevOps: cloud migration, Kubernetes, CI/CD, infrastructure as code (Terraform), DevSecOps, FinOps and site reliability engineering on Azure and AWS.
Product and software engineering: custom software, investor portals, internal operations tools, APIs and integrations with custodians and data vendors, QA and testing.
Production AI: AI inside existing applications, RAG and LLM assistants, document processing, fraud and anomaly detection, claims and underwriting models. We ship AI to production, not to slide decks.

Financial services know how: AIFMD Annex IV, UCITS KIID and PRIIPs, Central Bank of Ireland reporting and CP86, DORA ICT risk and third party documentation, MiFID II, Solvency II, GDPR, KYC and client onboarding, FATCA and CRS, digital asset custody.

Selected work:
Waystone, a global fund governance firm with €1.3T+ assets under management: we moved core holdings and risk data from fragile SSIS jobs to a monitored AWS data lake. 100TB+ of data is processed daily, and committee and regulatory packs now come from a single trusted data layer with full audit trails.
Companjon (embedded insurance): a Kafka and Databricks pipeline that captures 100% of API gateway traffic in real time with zero latency impact on production.
iRace Digital (FundBank): client onboarding and KYC across the US, Luxembourg and the Cayman Islands, and self hosted digital asset custody infrastructure on AWS.

Trust: ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned, GDPR compliant, Irish registered company with professional indemnity insurance, a disaster recovery site in Germany and full IP assignment to the client. Profitable with no debt since 2007.

People: 140 people across engineering, architecture, UX and delivery. Head office in Sandyford, Dublin, our own delivery centres in Ahmedabad (since 2010) and Kolkata (since 2015), India, and resident engineers in Ireland and the UK. Engineers join the client's standups and work in the client's tools (Slack, Teams, Jira).

Key numbers: 18+ years in business, 250+ projects delivered, 5.0 client rating on Clutch, engineers embedded in 7 to 10 business days.

## Оффер (2 110 из 3 000) — вариант с Blueprint Call в конце

We put a senior engineer into your team, backed by a solutions architect, a project manager and DevOps, all under one contract and at a fixed monthly price. Built for fund administrators, asset managers, banks, payments firms, insurers, insurtechs and software vendors that sell into regulated markets.

Precision Pod: 1 senior engineer (5+ years experience), PM included (up to 6 to 8 hours per month), architecture reviews (up to 2 hours per week), DevOps and QA assist. From €5k to €6k per month.
Pair Pod: 2 senior engineers (for example Data plus Backend). From €10k to €11k per month.
Mini Team: 3 engineers (for example Data plus Backend plus DevOps). From €15k to €16k per month.
Also available: managed teams, staff augmentation and fixed price projects.

How it starts: the engineer joins your standups and works in your tools within 7 to 10 business days of a signed agreement. 3 month minimum, then 30 days notice. No hidden overages: anything beyond the included PM and architecture hours is agreed upfront. You own the code and the IP.

We add capacity alongside your team or current vendor, often starting with one engineer on a specific backlog item or pipeline problem. We work in your stack: if you are on Azure and Power BI, we work in Azure and Power BI, and we modernise step by step, proving value before expanding scope.

Swap guarantee: if the engineer is not the right fit in the first 2 weeks, we replace them within 5 business days at no cost.

We are ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned and GDPR compliant, so vendor due diligence moves quickly.

Easiest first step: we send the Waystone case study (published on hst.ie) or our 1 page Stabilise and Ship plan for taking a fragile data platform to production ready (assess in week 1, stabilise by week 6, ship by week 12).

For teams that want to go further, a 20 minute Blueprint Call with one of our senior architects comes at no cost: we look at your data or engineering problem, share how we solved something similar for fund administrators, banks or insurers, and you leave with a technical roadmap for it.

## Оффер без Blueprint Call (1 821 из 3 000)

We put a senior engineer into your team, backed by a solutions architect, a project manager and DevOps, all under one contract and at a fixed monthly price. Built for fund administrators, asset managers, banks, payments firms, insurers, insurtechs and software vendors that sell into regulated markets.

Precision Pod: 1 senior engineer (5+ years experience), PM included (up to 6 to 8 hours per month), architecture reviews (up to 2 hours per week), DevOps and QA assist. From €5k to €6k per month.
Pair Pod: 2 senior engineers (for example Data plus Backend). From €10k to €11k per month.
Mini Team: 3 engineers (for example Data plus Backend plus DevOps). From €15k to €16k per month.
Also available: managed teams, staff augmentation and fixed price projects.

How it starts: the engineer joins your standups and works in your tools within 7 to 10 business days of a signed agreement. 3 month minimum, then 30 days notice. No hidden overages: anything beyond the included PM and architecture hours is agreed upfront. You own the code and the IP.

We add capacity alongside your team or current vendor, often starting with one engineer on a specific backlog item or pipeline problem. We work in your stack: if you are on Azure and Power BI, we work in Azure and Power BI, and we modernise step by step, proving value before expanding scope.

Swap guarantee: if the engineer is not the right fit in the first 2 weeks, we replace them within 5 business days at no cost.

We are ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned and GDPR compliant, so vendor due diligence moves quickly.

Easiest first step: we send the Waystone case study (published on hst.ie) or our 1 page Stabilise and Ship plan for taking a fragile data platform to production ready (assess in week 1, stabilise by week 6, ship by week 12).

## Подпись

Huze Hakim
CTO and Founder, HST Solutions
hst.ie

## Кому продавать (рамка для гипотез)

- Fund administrators, ManCos and asset managers in Ireland and Luxembourg: data platform modernisation and regulatory reporting (AIFMD, UCITS)
- Fund services and fund technology firms (transfer agency, depositary, fund data) in Ireland, Luxembourg and the UK
- Wealth managers, private banks and investment platforms in Ireland, the UK and the EU with their own technology teams
- Insurers and insurtechs in Ireland, the UK and the EU: real time partner and claims data, AI that goes live in production
- Retail banks, private banks and digital banks in the UK, the EU and the US East Coast that need senior engineering capacity
- Banks and digital asset firms working on client onboarding, KYC or custody infrastructure
- Payments companies, e-money institutions and fintechs with an existing engineering function
- B2B software vendors selling into financial services or other regulated markets, with an engineering team of 20+
- Asset and fund managers in the UK, Germany, the Netherlands and the Nordics: data platform modernisation and regulatory reporting
- Insurance brokers, MGAs and reinsurers in Ireland, the UK and the EU with in-house technology teams

## Кому НЕ продавать

- Software development agencies, IT consultancies, outsourcing and staff augmentation firms (competitors, not buyers)
- Management and digital consultancies and system integrators
- Recruitment agencies, staffing firms and IT contractor marketplaces
- Companies with no in-house technology, engineering or delivery function
- Independent financial advisers, small advisory practices, accountancy firms and other small firms without a technology team
- Consumer retail, e-commerce, hospitality, construction, media, local services and other sectors outside financial services and insurance
- Healthcare, pharma, energy and other non-financial regulated companies themselves (B2B software vendors selling to them do qualify)
- Students, job seekers and individual freelancers

**Размер:** 200+ employees, or smaller fintechs, insurtechs and software vendors (from 50 employees) with an in-house engineering team of 20+

**География:** Ireland, United Kingdom, EU (priority: Netherlands, Luxembourg, Germany, Denmark, Sweden, Finland, Norway) and US East Coast states only (e.g. New York, Massachusetts, New Jersey, Connecticut)

## Кейсы

### Waystone

Waystone, a global fund governance firm with €1.3T+ assets under management, had a legacy SQL Server estate with fragile nightly SSIS jobs. HST moved core holdings and risk data to a monitored AWS data lake and consolidated risk and oversight reporting in Power BI. 100TB+ of data is now processed daily, regulatory packs come from a single trusted data layer with full audit trails, and a separate ETL tool frees up to 40% of analyst time.

### Companjon

Companjon sells embedded insurance through e-commerce, travel and mobility partners across Europe, and every partner creates continuous API traffic. HST built a Kafka pipeline mirroring all API gateway traffic, streaming into Databricks, with near real time partner dashboards and access controls. Result: 100% of API traffic captured in real time with zero latency impact on production.

### iRace Digital (FundBank)

iRace Digital (FundBank) serves institutional investors and fund structures across the US, Luxembourg and the Cayman Islands, so onboarding has to satisfy three regulators at once. HST built a shared data model and portal foundation for onboarding (KYC, beneficial ownership, sanctions and PEP screening, FATCA and CRS) and automated self hosted digital asset custody infrastructure on AWS. Result: a new onboarding journey is mostly configuration, and the bank keeps full control of its key material.


## Client brief (text of the filled .docx, contact phones/emails and agency template removed)

BRIEF ON OUTREACH
BRIEF ON OUTREACH
Please fill out the brief in as much detail as possible. The better you describe your activity, the more it will affect the effectiveness of Email Outreach.

DESCRIPTION OF THE COMPANY ---------------------------------------------
Link to the current website:
https://www.hst.ie
Brief description of the activity/company/product:
HST Solutions is an Irish software engineering and AI company, founded in Dublin in 2007. We give financial services and other regulated businesses senior engineers who are productive from week one, backed by a full delivery pod: solutions architect, project manager and DevOps, all under one contract.
Our four practices are data and analytics engineering, cloud and DevOps, product and software engineering, and production AI. Most of our work is for fund administrators, asset managers, banks, insurers and insurtechs across Ireland, the UK, Europe and the US.
We are ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned and GDPR compliant. Head office is 6 Fern Road, Sandyford Business Park, Dublin 18, D18 FP98, with our own delivery centres in Ahmedabad (since 2010) and Kolkata (since 2015) and resident engineers in Ireland and the UK.
e-mail, telegram)
Expected number of leads
Our goal is 2 to 4 qualified leads per month, meaning attended discovery calls that meet Appendix 1 of our agreement. We are happy to set the final monthly KPI with you after the 45 day test period.

DESCRIPTION OF THE TARGET AUDIENCE ----------------------------------
Positions, industry, decision maker, location, etc. (For example, Marketing Director, VP of Engineering in real estate in Canada)
Industries
Fund administration, asset management, wealth management, banking, payments, insurance, insurtech, and B2B software vendors that sell into financial services or other regulated markets.
Locations
Ireland, United Kingdom, European Union (priority: Netherlands, Luxembourg, Germany and the Nordics) and the US East Coast.
Company size
At least one of: 200+ employees, an internal technology team of 20+ people, or an existing engineering, technology or delivery function. Companies with no in house tech team are not a priority unless we approve them.
Decision makers
CTO, CIO, VP of Engineering, Head of Engineering, Head of Delivery, Head of Data, Head of Technology Operations, or an equivalent budget holder or senior technology stakeholder. Procurement or talent acquisition contacts only when they are actively sourcing technology contractors, external engineering capacity or delivery partners.
Signals that a company is a strong fit
•  Senior data or software engineering roles open for months
•  Legacy SQL Server and SSIS estates that need to move to AWS or Azure
•  Regulatory reporting pressure (AIFMD Annex IV, UCITS, Central Bank of Ireland, DORA)
•  Preparing for a Central Bank inspection or a DORA third party review
•  AI projects stuck at proof of concept
•  Insurers and insurtechs dealing with real time partner data or claims automation
•  Banks and digital asset firms working on client onboarding, KYC or custody
Suggested hypotheses (one email sequence each)
1. Fund administrators, ManCos and asset managers in Ireland and Luxembourg: data platform modernisation and regulatory reporting, using our Waystone work as proof.
2. Insurers and insurtechs in Ireland, UK and EU: real time data pipelines and AI that actually goes live, using our Companjon work as proof.
3. Banks, payments firms and FS software vendors in the UK, EU and US East Coast: senior engineering capacity in 7 to 10 business days from an ISO 27001 certified, DORA aligned partner.
Please do not contact
Other agencies, consultancies, recruiters or outsourcing firms, students and job seekers, and any company already in our client base or pipeline. We will send you a suppression list before launch.

DETAILED DESCRIPTION OF THE PRODUCT/SERVICE ---------------------
Specify the properties of the product, the assortment, and some statistics that characterize it from the best side.
HST provides senior engineers and small delivery teams to regulated companies. The client gets the specialist they need plus the support structure that makes them productive: architect reviews, project management and DevOps, under one commercial relationship.
What we do
•  Data and analytics engineering: data platform modernisation (SQL Server and SSIS to AWS or Azure data lakes), ETL and ELT pipelines, real time streaming (Kafka), data warehouses, Power BI and Tableau reporting, audit trails and data lineage.
•  Cloud and DevOps: cloud migration, Kubernetes, CI/CD, infrastructure as code (Terraform), DevSecOps, FinOps and site reliability engineering on Azure and AWS.
•  Product and software engineering: custom software, web and mobile apps, investor portals, internal operations tools, APIs and integrations with custodians and data vendors, QA and testing.
•  Production AI: AI inside existing applications, RAG and LLM assistants, document processing, fraud and anomaly detection, claims and underwriting models. We ship AI to production, not to slide decks.
Financial services know how
AIFMD Annex IV automation, UCITS KIID and PRIIPs, Central Bank of Ireland reporting and CP86, DORA ICT risk and third party documentation, MiFID II, Solvency II, GDPR, KYC and client onboarding, FATCA and CRS, digital asset custody.
How clients buy from us
•  Precision Pod: 1 senior engineer, PM included (up to 6 to 8 hours per month), architecture reviews (up to 2 hours per week), DevOps and QA assist. From €5k to €6k per month.
•  Pair Pod: 2 senior engineers (for example Data plus Backend). From €10k to €11k per month.
•  Mini Team: 3 engineers (for example Data plus Backend plus DevOps). From €15k to €16k per month.
•  Also available: managed teams, staff augmentation, fixed price projects, and a 6 week software prototype from €24,000.
•  3 month minimum, then 30 days notice. No hidden overages.
Technology
Azure, AWS, Databricks, Snowflake, Kafka, Spark, Airflow, dbt, .NET, Java, Python, Node.js, React, React Native, Angular, Kubernetes, Terraform, Power BI, Tableau.
Key numbers
18+ years in business, 250+ projects delivered, 5.0 client rating on Clutch, 100TB+ of data processed daily for fund administrators, engineers embedded in 7 to 10 business days.

THE PRICE CATEGORY OF YOUR PRODUCT/SERVICE ----------------------
Put a "+” next to the desired field.
Economy class

The middle class

Business Class
+
A luxury item

5 ADVANTAGES OF YOUR COMPANY/PRODUCT ----------------------------
Describe the 5 advantages (reasons) to contact/place an order with you. Highlight in bold the most basic and unique advantage that distinguishes you from your competitors.
1. A full delivery pod, not a single contractor. Every engagement comes with a senior engineer (minimum 5 years experience) plus architect reviews every sprint, a dedicated project manager and DevOps support, all under one contract and one point of contact. Engineers are embedded in the client team in 7 to 10 business days, at a fixed monthly price.
2. Built for regulated financial services. ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned and GDPR compliant. We already speak AIFMD, UCITS, Central Bank of Ireland, MiFID II and Solvency II, so vendor due diligence moves quickly.
3. Proven with one of the largest fund governance firms in the world. We have worked with Waystone (€1.3T+ assets under management) for several years on data platforms, ETL, risk and regulatory reporting, processing 100TB+ of data daily.
4. Software and AI under one roof. Most AI consultancies cannot build production software and most dev shops cannot do ML. We do both with one team and one contract, and we take it all the way to production.
5. Low risk to try. Start with a single engineer, 3 month minimum then 30 days notice, swap guarantee in the first 2 weeks, full IP ownership for the client. HST has been debt free and profitable since 2007.
	
5 PROBLEMS IN WORKING WITH YOUR COMPETITORS ------------------
Describe 5 problems of your competitors, or 5 problems that your customers face when choosing a product/service.
1. Hiring takes too long. A senior data engineer in Ireland can take 6+ months to hire and costs €80k to €120k in salary before overheads. Regulatory deadlines and the Central Bank do not wait.
2. Contractors work alone. Marketplaces and contractors give you one person with no PM, no architect and no accountability. When they get stuck there is no team behind them, and they can walk away mid project.
3. Big consultancies are slow and expensive. 8 to 12 weeks to start, €200k+ projects, generic consultants who do not know fund admin or insurance, and a change request for everything.
4. Offshore only teams and AI shops rarely ship. Time zone and communication lag, work that stays at proof of concept or slide deck stage, and no one who owns production reliability.
5. Suppliers that fail vendor security reviews. Many providers cannot show ISO 27001, business continuity certification or DORA third party documentation, which stalls procurement and puts the buyer at risk with their regulator.

A UNIQUE TRADE OFFER -------------------------------------------------------
A senior engineer embedded in your team within 7 to 10 business days, backed by an architect, a project manager and DevOps, for a fixed €5k to €6k per month. ISO 27001 certified and DORA aligned. If the fit is not right in the first 2 weeks, we replace the engineer within 5 business days at no cost.
Opening step for every prospect: a free 20 minute Blueprint Call with one of our senior architects, where we look at their data or engineering problem and share how we solved something similar for fund administrators, banks or insurers.

IMPRESSIVE FIGURES -----------------------------------------------------------
The age of the company, the number of completed projects, the duration of the service, and other information in numbers that will help impress the client. 
For example (“5 years of work experience", “2032 completed orders", “120 satisfied customers")
•  18+ years in business (founded in Dublin in 2007)
•  250+ successful projects delivered
•  5.0 client rating on Clutch, rated one of the Top Dublin Custom Software Developers
•  100TB+ of data processed daily for fund administration clients
•  €40M+ in funding secured by the startups we have built for
•  1M+ users served daily by software we built
•  2 own delivery centres in India (Ahmedabad and Kolkata), plus resident engineers in Ireland and the UK
•  140 people across engineering, architecture, UX and delivery
•  Up to 40% of analyst time freed for the Waystone risk and regulatory reporting team
•  Long client relationships: Waystone for several years, CameraMatics since 2018, Boom22 since 2013
•  Debt free and profitable since 2007
•  Client relationships from €25k to €1M per year
•  Revenue spread: 40% Ireland, 20% UK, 20% India, 10% USA, 10% rest of the world

SPECIAL OFFER/SPECIAL OFFER ----------------------------------------------
If you currently have some kind of promotion that is worth specifying, then describe it in the field below. If it is not relevant, then put "-".
No time limited promotion at the moment. Standing offers you can use in the emails:
•  Free 20 minute Blueprint Call with a senior architect
•  Swap guarantee: if the engineer is not the right fit in the first 2 weeks, we replace them within 5 business days at no cost
•  6 week software prototype from €15,000 with a money back guarantee if we do not deliver a working prototype

WHAT QUESTIONS ARE YOU BEING ASKED? --------------------------------
What are the most frequently asked questions by your future clients? What objections do you have? (For example, where are you? / how is this product different from another? What are the deadlines? etc.)
Where are you based?
Head office in Sandyford, Dublin 18. Our own delivery centres are in Ahmedabad and Kolkata, India, with resident engineers in Ireland and the UK. Engineers join the client standups and work in their tools (Slack, Teams, Jira).
How are you different from a contractor or staff augmentation?
You get a delivery pod, not a CV. The senior engineer comes with architect reviews every sprint, a PM who handles scope and comms, and DevOps support. If the engineer gets stuck, they have a team behind them.
How much does it cost?
From €5k to €6k per month for one senior engineer with PM and architecture support included. Two engineers from €10k to €11k, three from €15k to €16k. No hidden overages.
How fast can you start?
7 to 10 business days from signed agreement to engineer in the team. Dedicated team builds take 2 to 4 weeks.
Will you pass our vendor due diligence?
Yes. ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned, GDPR compliant, Irish registered company, professional indemnity insurance, disaster recovery site in Germany, full IP assignment to the client.
Can you work with our current stack?
Yes. We mirror your stack. If you are on Azure and Power BI, we work in Azure and Power BI. We modernise step by step and prove value before expanding scope.
What is the minimum commitment?
3 months, then 30 days notice.
Objection: we already have an in house team or a vendor
We add capacity alongside your team, often starting with one engineer on a specific backlog item or pipeline problem.
Objection: we worry about offshore quality
Every engineer is senior (5+ years), an architect reviews every sprint, the contract and IP sit with an Irish company, and the swap guarantee covers the first 2 weeks.

WHAT PROBLEMS DO PEOPLE COME TO YOU WITH? ---------------------
An example for a software developer company: customers have a current system / website that has a lot of errors, because they did it for cheap. It is necessary to fix this and establish a stable work process.
•  Data pipelines that break at month end. Nightly SSIS jobs fail, reports are late, and regulatory deadlines (AIFMD, UCITS, Annex IV) do not move.
•  Legacy SQL Server estates that cannot scale. They need to move to AWS or Azure data lakes without disrupting operations.
•  Manual data reconciliation. Operations teams stuck with Excel exports, ad hoc fixes and no audit trail.
•  Open senior roles that nobody can fill. CTOs with senior data or engineering roles open for 6+ months who need delivery now.
•  Inspection and DORA readiness. Firms preparing for Central Bank inspections or DORA reviews that need documentation, data lineage and audit trails.
•  AI stuck in notebooks. Models and proofs of concept that never reach production.
•  Real time data for insurance. Partner data, quotes and claims arriving faster than batch systems can handle.
•  Projects that went wrong with another vendor. We take over existing projects and stabilise them.

WHAT RESULTS OF YOUR WORK CAN IMPRESS OF LEAD? ---------------
Example: We increased the number of monthly users of the application 115 times for one of our clients / We brought 100 leads per month for the cigarette manufacturer / The client increased the company's profit by 80% thanks to us
•  Waystone (€1.3T+ AUM): moved core holdings and risk data from fragile SSIS jobs to a monitored AWS data lake. 100TB+ processed daily, and data consumers now build on a documented lake instead of ad hoc exports.
•  Waystone risk and oversight reporting: committee and regulatory packs that used to take days of manual consolidation now come from a single trusted data layer with full audit trails.
•  Waystone PPM: an ETL tool that frees up to 40% of analyst time previously spent managing data, running 1,000 jobs at a time every 15 minutes.
•  Companjon (embedded insurance): 100% of API gateway traffic captured in real time with zero latency impact on production, giving product and partner teams near real time dashboards.
•  iRace Digital (FundBank): rebuilding client onboarding and KYC across the US, Luxembourg and the Cayman Islands, and building self hosted MPC digital asset custody infrastructure on AWS.
•  BSI (UK national standards body): built BSI PACE, a multi tenant SaaS platform for GDPR privacy assessments.

WHAT GUARANTEES DOES YOUR CLIENT RECEIVE? -----------------------
For example: “2 months Return Guarantee”, “Quality Guarantee”, “6 months Warranty". If it is not relevant, then put "-".
•  Swap guarantee: if the engineer is not the right fit in the first 2 weeks, we replace them within 5 business days at no cost.
•  Delivery guarantee: if we ever fail to deliver or meet agreed expectations, we commit our own resources to make it right.
•  6 week prototype money back guarantee: if we do not deliver a working, testable prototype within 6 weeks of the agreed start, the client gets a full refund.
•  No lock in: 3 month minimum, then 30 days notice. The client owns the code and IP.
•  No hidden overages: anything beyond the included PM and architecture hours is agreed upfront.

WHAT KIND OF LEAD MAGNETS DO YOU HAVE? --------------------------- What can we give a person in return for his answer? This can be: free access, audit, exclusive report, market research/niche, market news, gifts, bonuses, guides, etc.
•  Free 20 minute Blueprint Call with a senior architect, giving a personalised technical roadmap for their problem.
•  Waystone case study (downloadable from hst.ie): how we modernised data platforms for a €1.3T+ fund governance firm.
•  The 1 page "Stabilise and Ship" plan: our 12 week programme to take a fragile data platform to production ready (assess in week 1, stabilise by week 6, ship by week 12).
•  Guides on hst.ie: "The True Cost of Custom Software Development in Ireland" and "Reality of AI Adoption for Irish Business: 5 Mistakes to Avoid".
•  Relevant articles for FS audiences, for example "What Forward Deployed AI Engineering Means for EU Fund Administrators Under DORA" and "Certified DevOps Provider vs Building an Internal Team: Which Meets DORA Requirements Faster".

WHO DO WE TRANSFER LEADS TO? ------------------------------------------
Whose mail we will copy when transmitting warm leads. The name, email and position are important.
Huze Hakim, CTO 

ON WHOSE BEHALF ARE WE CONDUCTING THE DIALOGUE? ------------
On whose behalf the dialogue with the leaders in the offer will take place. The name and position are important.
Huze Hakim, CTO and Founder, HST Solutions

ARE YOUR CURRENT CLIENTS? -----------------------------------------------
Give an example of your 3-5 active clients so that we can analyze them. It is enough to specify any data (website / name / TIN). 
•  Waystone, global fund governance and fund administration: waystone.com
•  iRace Digital (FundBank), banking, fund services and digital asset custody: fundbank.com
•  CameraMatics, fleet telematics SaaS: cameramatics.com
•  StatSports, wearable performance technology: statsports.com
Note: all current clients and pipeline companies will be on our suppression list, so please do not contact them.

YOUR LATEST CASES ------------------------------------------------------------
Describe 2-3 successful cases of companies, who have been contacting you recently. It is necessary to register: the name of the company, the essence of the request, what was done and what results were obtained at the output (we need exactly such examples that we can specify in the chain of letters).
1. Waystone: data platform modernisation
Request: Waystone, a global fund governance firm with €1.3T+ assets under management, had a legacy SQL Server estate that could not scale with fund volumes. Nightly SSIS jobs were fragile, documentation was thin, and the team spent more time firefighting than building.
What we did: migrated core holdings and risk data to an AWS S3 and Iceberg data lake, built automated pipelines with Glue, DMS and CDC, set up Athena for analysts with Lake Formation governance, replaced SSIS packages with monitored and tested jobs, and wrote runbooks for the operations team. We also consolidated risk and oversight reporting into Power BI.
Result: 100TB+ processed daily on monitored pipelines. Committee and regulatory packs now come from a single trusted data layer with full audit trails, and manual consolidation is gone.
2. iRace Digital (FundBank): onboarding, KYC and digital asset custody
Request: iRace Digital, trading as FundBank, serves institutional investors and fund structures across the US, Luxembourg and the Cayman Islands, so onboarding has to satisfy three regulators at once. They also wanted to run their own MPC signing infrastructure instead of leaving key shares with the vendor.
What we did: built a shared data model and portal foundation for onboarding (KYC, beneficial ownership, sanctions and PEP screening, FATCA and CRS, MiFID II categorisation) on Microsoft Dynamics and Power Platform, and designed and automated the self hosted DFNS MPC custody estate on AWS with Terraform, strong key isolation and tested recovery.
Result: onboarding becomes a family of configurable workflows, so a new journey is mostly configuration, and the bank keeps full control of its key material with controls it can show a supervisor.
3. Companjon: real time data for embedded insurance
Request: Companjon sells embedded insurance through e commerce, travel and mobility partners across Europe. Every partner creates continuous API traffic that needed real time processing without slowing production.
What we did: built a Kafka streaming pipeline mirroring all API gateway traffic, Python consumers streaming into Databricks (bronze, silver and gold layers), near real time partner dashboards, and governance and access controls.
Result: 100% of API traffic captured in real time with zero latency impact on production, and product and partner teams now make decisions on live data.

SOCIAL PROOF & SALES SCRIPTS --------------------------------------------
Which of the listed social evidence do you have? Put a "+" next to the required field:
Ratings and reviews
+ 5.0 rating on Clutch (clutch.co/profile/hst-solutions), rated one of the Top Dublin Custom Software Developers. Also listed on GoodFirms.
Videos / podcasts / performances / audio, etc.
-
Photos / Pictures
+ Client logos, leadership team photos and case study visuals on hst.ie and hst.ie/about-us
Recommendations
+ Written testimonials on hst.ie from Waystone (Deputy CEO) and Nova Leah (CEO), plus named client quotes from CameraMatics, BSI, JCDecaux, Nocomed and Emotionise
Successful cases
+ 20+ case studies at hst.ie/work, including Waystone, iRace Digital (FundBank), Companjon, BSI, StatSports and Nova Leah
Awards / Certificates
+ ISO 27001:2022 and ISO 22301:2019 certificates, DORA aligned, GDPR compliant, Clutch Top Dublin Custom Software Developers
Mentions in the media
-
Company / service / product presentations

Are you ready to provide recordings of sales calls?

Are you ready to provide sales scripts?


THANK YOU!

THANK YOU!
