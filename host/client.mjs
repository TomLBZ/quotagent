// Product composition: plugin-owned components register into the generic WebUI shell.
import '../src/system/accounts/client/accounts.jsx'
import '../src/system/plugin-manager/client/manager.jsx'
import '../src/system/settings/client/settings.jsx'
import '../src/domain/procurement/client/procurement.jsx'
import '../src/system/agent-runtime/client/assistant.jsx'
import '../src/system/plugin-studio/client/studio.jsx'
import '../src/domain/ingestion/client/ingestion.jsx'
import { mountApp } from '../src/system/webui/client/core.jsx'
mountApp()
