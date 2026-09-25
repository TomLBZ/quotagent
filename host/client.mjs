// Product composition: plugin-owned components register into the generic WebUI shell.
import '../src/system/accounts/client/accounts.jsx'
import '../src/domain/procurement/client/procurement.jsx'
import '../src/system/agent-runtime/client/assistant.jsx'
import '../src/system/plugin-studio/client/studio.jsx'
import { mountApp } from '../src/system/webui/client/core.jsx'
mountApp()
