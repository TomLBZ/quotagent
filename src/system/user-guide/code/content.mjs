const clients=['contractor','supplier'],all=[...clients,'admin']
export const contentSources=[
 'docs/design/architecture.md','docs/product/getting-started.md',
 'src/domain/procurement/code/service.mjs','src/domain/ingestion/requirements/README.md',
 'src/system/mail/requirements/product.md','src/system/telegram/requirements/README.md',
 'src/system/agent-connections/requirements/functional.md','src/system/agent-workflows/code/index.mjs',
 'src/system/workspace-styles/requirements/README.md','src/system/agent-runtime/client/assistant.jsx','src/system/agent-runtime/requirements/usage.md',
]
export const tours={
 contractor:{title:'From a brief to a considered decision',intro:'Your agent prepares the work. You choose the suppliers and approve what leaves your workspace.',steps:[
  {title:'Start with the outcome',body:'Tell your agent what you need to source. Paste a brief, ask it to compare existing offers, or ask for your next useful step. Drafts remain editable.',view:'agent',label:'Open agent workspace',icon:'spark'},
  {title:'Bring in the source',body:'Upload an email, spreadsheet or document. Review the extracted descriptions, quantities, units and currency before importing a private request draft.',view:'ingestion',label:'Open document ingestion',icon:'file'},
  {title:'Review the quotation work',body:'Check the request and invited suppliers before publishing. When offers arrive, compare price, delivery and terms together. Ask your agent to draft a clarification when details are missing.',view:'rfqs',label:'Open requests',icon:'quote'},
  {title:'Make the decision',body:'An agent can prepare an award or message for review. Open its exact contents, approve only when ready, then follow the resulting order and receipt. Nothing in this tour commits you.',view:'approvals',label:'Open review actions',icon:'check'},
 ]},
 supplier:{title:'From an opportunity to a reviewed offer',intro:'Keep your pricing work private while your agent helps you understand and respond to the request.',steps:[
  {title:'Ask where to begin',body:'Ask your agent to read your incoming requests, point out missing scope, and suggest which opportunity needs attention first. It works with your account’s information.',view:'agent',label:'Open agent workspace',icon:'spark'},
  {title:'Check the scope',body:'Open an incoming request. Read quantities, units, deadline and requirements before preparing an offer. Use project messages to clarify anything that affects your price.',view:'rfqs',label:'Open requests',icon:'file'},
  {title:'Build your private quote',body:'Enter unit prices, your private costs, lead time and payment terms. Import an existing offer if useful, then reconcile its currency and units with the chosen request. Review the draft before submitting.',view:'quotes',label:'Open quotations',icon:'quote'},
  {title:'Review and follow through',body:'Agent-prepared submissions and external replies wait for your decision in Review actions. After an award, open Orders to review and acknowledge it. Your private cost figures stay in your workspace.',view:'approvals',label:'Open review actions',icon:'check'},
 ]},
 admin:{title:'A workspace your team can rely on',intro:'Administration is separate from supplier and contractor work. Start with the capabilities your team needs.',steps:[
  {title:'Work with your agent',body:'Use your agent workspace for questions and personal tools. Use an agent run when a task benefits from an explicit plan, specialist work and checkpoints.',view:'agent',label:'Open agent workspace',icon:'spark'},
  {title:'Manage people and access',body:'Administration lets you manage account roles and access controls. Each person has one client role, or a separate administrator role.',view:'admin',label:'Open administration',icon:'users'},
  {title:'Choose the application capabilities',body:'Application plugins shows the actual native plugins and their dependencies. Enable the capabilities the team needs; disabling a plugin removes its registered effects.',view:'plugins',label:'Open application plugins',icon:'puzzle'},
  {title:'Set shared defaults deliberately',body:'Plugin settings contains shared defaults and your own account settings. Mail, messaging and connection credentials belong only to the signed-in account. Shared personal extensions can be reviewed in Plugin studio.',view:'plugin-settings',label:'Open plugin settings',icon:'settings'},
 ]},
}
export const topics=[
 {id:'contractor-work',group:'Get started',roles:['contractor'],title:'Prepare a request and compare offers',summary:'Turn the source into clear scope, then judge price and terms together.',icon:'file',steps:[
  'Start in the agent workspace with the outcome, source brief and any known deadline or delivery constraints. Ask for an editable request draft.',
  'Open Requests to check the title, line descriptions, quantities, units, currency and invited suppliers. A private draft is visible only in your account until you publish it.',
  'After supplier submissions arrive, open the request comparison. Look at the full total, lead time, payment terms and missing scope. Ask the agent for a grounded comparison or a draft clarification.',
  'Review the chosen offer and approve the award when ready. The resulting order records the decision; follow the supplier acknowledgment in Orders.',
 ],note:'The agent can prepare a decision, but your approval is required to publish, award or commit. A low price alone does not resolve missing scope.',actions:[{view:'rfqs',label:'Open requests'},{view:'quotes',label:'Open quotations'},{view:'orders',label:'Open orders'}]},
 {id:'supplier-work',group:'Get started',roles:['supplier'],title:'Prepare and submit a quotation',summary:'Understand the requested scope and keep your cost work private.',icon:'quote',steps:[
  'Open Requests and choose an incoming request. Check line quantities, units, currency and deadline. Clarify missing scope before pricing it.',
  'Prepare a quote with unit prices, private costs if useful, lead time, payment terms and notes. Save it as a draft while you are still working.',
  'Ask the agent to check the draft or prepare a response. Review the complete quote before submitting it to the contractor.',
  'If you receive an award, open Orders, check the details and acknowledge it. Use the same project conversation for follow-up questions and changes.',
 ],note:'Your costs stay in your account. Your view contains your own offers; it does not reveal or rank competitors’ private bids.',actions:[{view:'rfqs',label:'Open requests'},{view:'quotes',label:'Open quotations'},{view:'orders',label:'Open orders'}]},
 {id:'admin-work',group:'Get started',roles:['admin'],title:'Manage accounts and the application',summary:'Separate team access, native capabilities and shared defaults.',icon:'shield',steps:[
  'Open Administration to review people, roles and access controls. Client roles see only their own side of the quotation workflow.',
  'Open Application plugins to inspect the native inventory and dependencies. Enable or disable optional capabilities there.',
  'Use Plugin settings for shared defaults. Read the setting scope: account-owned connections and personal preferences remain yours, even when you are an administrator.',
  'Review shared extensions in Plugin studio before promoting a useful one to a global default. A personal workspace style does not change everyone else’s style.',
 ],actions:[{view:'admin',label:'Open administration'},{view:'plugins',label:'Open application plugins'},{view:'plugin-settings',label:'Open plugin settings'}]},
 {id:'agent-chat',group:'Work with AI',roles:all,title:'Give your agent a useful task',summary:'Start with an outcome and the information that matters.',icon:'spark',steps:[
  'Describe what you want to achieve, then provide the brief, selected request or source document. For example: “Compare these offers and draft the two most useful questions before I decide.”',
  'Say what is known, what is missing and any constraints. The agent can read your workspace, use available tools, prepare drafts and suggest next steps.',
  'Open the returned draft or source link and review the facts. If a source is incomplete, add the missing detail rather than treating an invented assumption as agreed scope.',
  'For a longer task, use Agent workroom to follow an explicit plan and specialist steps. For a reusable task, ask for a saved skill.',
 ],note:'A provider must be configured for live AI. Drafting and analysis do not replace your review of a commercial decision.',actions:[{view:'agent',label:'Open agent workspace'},{view:'plugin-settings',label:'Open provider settings'}]},
 {id:'assistant-controls',group:'Work with AI',roles:all,title:'Pause, steer or stop your assistant',summary:'Change direction without losing the work already recorded.',icon:'spark',steps:[
  'While the assistant is working, its task card shows the current state and the tool results already saved. Use Pause task when you want to inspect the direction.',
  'Type a correction or extra detail in the same composer. While work is running, guidance updates the current task; while paused, it is saved until you resume.',
  'Choose Resume task when you are ready to continue. Choose Stop task when this task should end.',
  'Return after a reload to inspect the saved state. Stopping does not remove drafts or undo actions that already completed; review those records separately.',
 ],note:'Your request context and account data remain available through the owning tools. An agent still needs your approval for a proposed external commitment.',actions:[{view:'agent',label:'Open agent workspace'}]},
 {id:'ai-usage',group:'Work with AI',roles:all,title:'Understand your AI usage',summary:'Inspect reported token counts and the calls behind them.',icon:'grid',steps:[
  'Open AI usage under Personalize. Choose the date range, model, provider, activity or status you want to inspect.',
  'Use the chart and recent calls to see when usage occurred and which work it served. Input and output counts come from recorded provider responses.',
  'Read the coverage note. Some providers or failed calls do not report every count; a missing value is different from a reported zero.',
 ],note:'Token counts are not a bill or a cost estimate. Cache and reasoning breakdowns are part of reported input/output totals, not additional tokens to add again. Administrators can select the separate all-account scope.',actions:[{view:'ai-usage',label:'Open AI usage'}]},
 {id:'agent-runs',group:'Work with AI',roles:all,title:'Follow an agent run',summary:'Plan, specialists, questions and a trace you can return to.',icon:'users',steps:[
  'Open Agent workroom and start a run with the desired outcome. Review the proposed plan and its specialist tasks.',
  'Follow each step as it works. When the team needs your input, answer the specific question so it can continue with the missing fact.',
  'Pause or cancel a run when the direction needs to change. Read its synthesis and source/tool trace before acting on the result.',
  'If work was interrupted, return to the saved run and choose its available recovery action. External commitments still go through their own human review.',
 ],actions:[{view:'workroom',label:'Open agent workroom'}]},
 {id:'reviews',group:'Get started',roles:all,title:'Review an action and understand its receipt',summary:'See the exact request before it is sent or applied.',icon:'check',steps:[
  'Open Review actions from navigation or from an agent’s proposed-action card. Check the exact recipient, text, record or tool input.',
  'Approve only when the contents are ready. Decline if they need changing, then edit the draft and prepare a new review.',
  'Read the result after execution. A succeeded receipt records what the service confirmed; an uncertain result means completion could not be established.',
  'For an uncertain external send, check the destination service before preparing another attempt. Do not assume that the absence of a receipt means nothing was delivered.',
 ],note:'SMTP acceptance confirms the mail server accepted the message. It does not prove that the recipient received or read it.',actions:[{view:'approvals',label:'Open review actions'},{view:'notifications',label:'Open notifications'}]},
 {id:'documents',group:'Sources & connections',roles:clients,title:'Import a document into editable line items',summary:'Review the source, mapping and units before creating a draft.',icon:'file',steps:[
  'Open Ingest documents and upload your files. Supported families include EML/MBOX/MSG, XLSX/XLS, CSV/TSV, DOCX, text PDF, TXT, HTML and JSON. Automatic selection chooses an available matching engine.',
  'Review the parsed text and table rows. Check column mapping, item descriptions, quantities, units and prices. Use AI extraction when a supported live provider is available.',
  'Edit the extracted line items. A contractor can create a private request draft. A supplier chooses a received request and matches its lines before creating a private quote.',
  'Reconcile currency and units explicitly before a supplier import. The application does not silently convert exchange rates or units for you.',
 ],note:'Image-only PDFs are not supported by the current text parser; use a file with selectable text. Check visible parser warnings and the available-engine choices.',actions:[{view:'ingestion',label:'Open document ingestion'}]},
 {id:'mail',group:'Sources & connections',roles:clients,title:'Connect email and prepare a reply',summary:'Read IMAP messages and review SMTP delivery inside your workspace.',icon:'mail',steps:[
  'Open Email settings and enter your account’s IMAP and SMTP endpoints, encryption, username and supported credentials. Use your mail provider’s connection details.',
  'Test the connection, then choose Sync email. Optional automatic sync can check for new mail. The initial sync reads a recent message window, not the whole archive.',
  'Open an email to read it, extract an attachment, or ask the agent to draft a reply. Review the recipient, subject, body and attachments.',
  'Choose Review send, then approve the frozen message in Review actions. The email page shows the recorded sending result.',
 ],note:'App passwords or a supplied OAuth access token are supported; provider sign-in and automatic OAuth token refresh are not included. Your credentials belong only to your account.',actions:[{view:'mail',label:'Open email'}]},
 {id:'telegram',group:'Sources & connections',roles:clients,title:'Connect a Telegram bot',summary:'Receive text and documents, then review outbound replies.',icon:'send',steps:[
  'Create a bot through Telegram’s BotFather, then enter its token in Telegram settings. This connects a bot, not your personal Telegram account.',
  'Start a conversation with that bot in Telegram, test the connection and receive messages. Use one polling consumer for the token; an existing webhook can prevent polling.',
  'Open a received document to extract line items, or prepare a reply. Review the text and chat destination before approving the send.',
  'If useful, explicitly enable generic activity reminders and choose a notification chat. Those reminders say new work is waiting; they do not forward private quote details.',
 ],note:'The current integration handles received text/documents and outbound text. Personal chat history, voice, stickers and outbound document sending are not included.',actions:[{view:'telegram',label:'Open Telegram'}]},
 {id:'connections',group:'Sources & connections',roles:all,title:'Connect an MCP server or A2A agent',summary:'Let your agent use a configured external capability.',icon:'puzzle',steps:[
  'Open Agent connections and add the endpoint and credentials for an MCP server or A2A agent that you control or intend to use.',
  'Test or discover the connection, then inspect the tools, resources or remote agent capabilities it exposes.',
  'Ask your agent to use a specific capability for your task. It can bring returned information into the current account’s work, with recorded tool activity.',
  'Review proposed external operations before execution. A remote agent may ask for more input or require you to continue or cancel a task.',
 ],note:'Connection success depends on the remote service and its protocol support. Received material is source data, not permission to ignore your instructions.',actions:[{view:'connections',label:'Open agent connections'}]},
 {id:'project-messages',group:'Get started',roles:clients,title:'Keep clarification with the project',summary:'Use the request conversation for scope and negotiation context.',icon:'chat',steps:[
  'Open Messages and choose the request. Select the intended participant and explain the specific scope or commercial question.',
  'Ask your agent for a draft when useful. Check names, numbers and the question you want answered before sending.',
  'Return to the thread when revising a quotation or considering an award so that agreed clarifications are not lost in a separate conversation.',
 ],actions:[{view:'messages',label:'Open project messages'}]},
 {id:'memory',group:'Work with AI',roles:all,title:'Inspect and change account memory',summary:'Keep useful preferences explicit and editable.',icon:'file',steps:[
  'Open Account memory in Agent workroom to inspect the preferences currently available to your agent.',
  'Add or edit a specific preference, such as a preferred comparison format. Include enough context for it to be useful later.',
  'Review model-suggested memories before accepting them. Archive a memory when it is outdated or no longer appropriate.',
 ],note:'Email bodies, remote tool output and quotation notes are source material. They should not silently become a permanent instruction.',actions:[{view:'workroom',label:'Open account memory',context:{tab:'memory'}}]},
 {id:'personal-tools',group:'Personalize',roles:all,title:'Build a personal plugin or saved skill',summary:'Ask for a useful capability and inspect it before sharing.',icon:'puzzle',steps:[
  'Open Plugin studio or ask your agent for a specific tool. Describe the input, expected result and how you want to use it.',
  'Inspect the generated extension or skill. Try it in your own workspace, adjust its configuration and disable it when it is not useful.',
  'Share a useful extension in the marketplace when ready. Other accounts can install it; administrators can review shared work for a global default.',
 ],note:'Personal extensions can customize the supported plugin surface. They do not grant access to another account’s private quotation data.',actions:[{view:'extensions',label:'Open Plugin studio'}]},
 {id:'workspace-style',group:'Personalize',roles:all,title:'Change layout, colors and spacing',summary:'Make the workspace fit the way you work.',icon:'sun',steps:[
  'Open Workspace style and choose Focus, Balanced or Classic. Focus starts with your agent and opens the assistant on demand elsewhere; Balanced keeps it beside detailed work on wide screens; Classic starts with records or administration.',
  'Choose a light color palette and comfortable or compact spacing, then save your workspace style.',
  'The choice stays with your account across reloads. An active generated theme supplies its own colors until you disable it in Plugin studio.',
 ],actions:[{view:'workspace-style',label:'Choose workspace style'}]},
 {id:'settings-help',group:'Personalize',roles:all,title:'Find account and plugin settings',summary:'Change the right scope without mixing personal and shared preferences.',icon:'settings',steps:[
  'Account settings contains your profile and account-level controls. Plugin settings groups configuration contributed by enabled plugins.',
  'Choose the specific plugin and edit the fields you intend to change. Password fields can stay blank to keep the saved secret; use the explicit clear control to remove it.',
  'Check the scope description before saving. Connection credentials and workspace styles belong to your account; administrators also have separate shared defaults where supported.',
 ],actions:[{view:'settings',label:'Open account settings'},{view:'plugin-settings',label:'Open plugin settings'}]},
]
export const forRole=role=>topics.filter(topic=>topic.roles.includes(role)).map(({roles,...topic})=>structuredClone(topic))
