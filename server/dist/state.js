"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.getPending = getPending;
exports.savePending = savePending;
exports.clearPending = clearPending;
exports.saveProfile = saveProfile;
exports.profilesForUser = profilesForUser;
exports.selectedProfile = selectedProfile;
exports.claimLegacyProfile = claimLegacyProfile;
exports.selectProfile = selectProfile;
exports.hasAnyProfile = hasAnyProfile;
/** Portal 文件状态仓库：支持多连接器、按平台用户隔离选择与接入进度。 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function dataDir() {
    return process.env.PORTAL_DATA_DIR || path.join(os.homedir(), ".bonfire-connector");
}
function stateFile() {
    return process.env.PORTAL_STATE_FILE || path.join(dataDir(), "portal-state.json");
}
function emptyState() {
    return { version: 2, connectors: {}, pending_by_user: {}, selected_by_user: {} };
}
function migrate(parsed) {
    if (parsed.version === 2)
        return parsed;
    const old = parsed;
    const next = emptyState();
    if (old.onboarded && old.connector_id && old.domain_id) {
        next.connectors[old.connector_id] = {
            connector_id: old.connector_id,
            domain_id: old.domain_id,
            lite_kuscia_endpoint: old.lite_kuscia_endpoint,
            lite_cert_dir: old.lite_cert_dir,
        };
    }
    if (old.pending?.owner_username) {
        next.pending_by_user[old.pending.owner_username] = old.pending;
    }
    return next;
}
let cache = null;
function loadState() {
    if (cache)
        return cache;
    try {
        cache = migrate(JSON.parse(fs.readFileSync(stateFile(), "utf-8")));
    }
    catch {
        cache = emptyState();
    }
    return cache;
}
function persist(next) {
    cache = next;
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    return next;
}
function getPending(username) {
    return loadState().pending_by_user[username];
}
function savePending(username, pending) {
    const st = loadState();
    return persist({ ...st, pending_by_user: { ...st.pending_by_user, [username]: pending } });
}
function clearPending(username) {
    const st = loadState();
    const pending = { ...st.pending_by_user };
    delete pending[username];
    return persist({ ...st, pending_by_user: pending });
}
function saveProfile(username, profile) {
    const st = loadState();
    // Re-registering a connector with the same Kuscia domain creates a new
    // platform connector ID.  The old local profile must not remain selectable:
    // it points at a deleted control-plane object and, more subtly, at the same
    // endpoint/certificate directory as the replacement deployment.
    const connectors = { ...st.connectors };
    for (const [connectorId, existing] of Object.entries(connectors)) {
        if (connectorId !== profile.connector_id &&
            existing.owner_username === username &&
            existing.domain_id === profile.domain_id) {
            delete connectors[connectorId];
        }
    }
    return persist({
        ...st,
        connectors: { ...connectors, [profile.connector_id]: { ...profile, owner_username: username } },
        selected_by_user: { ...st.selected_by_user, [username]: profile.connector_id },
    });
}
function profilesForUser(username) {
    return Object.values(loadState().connectors).filter((p) => p.owner_username === username);
}
function selectedProfile(username) {
    const st = loadState();
    const selected = st.selected_by_user[username];
    return (selected && st.connectors[selected]) || profilesForUser(username)[0];
}
function claimLegacyProfile(username, connectorId) {
    const st = loadState();
    const profile = st.connectors[connectorId];
    if (!profile || profile.owner_username)
        return profile;
    persist({
        ...st,
        connectors: { ...st.connectors, [connectorId]: { ...profile, owner_username: username } },
        selected_by_user: { ...st.selected_by_user, [username]: connectorId },
    });
    return { ...profile, owner_username: username };
}
function selectProfile(username, connectorId) {
    const st = loadState();
    const profile = st.connectors[connectorId];
    if (!profile || profile.owner_username !== username)
        return undefined;
    persist({ ...st, selected_by_user: { ...st.selected_by_user, [username]: connectorId } });
    return profile;
}
function hasAnyProfile() {
    return Object.keys(loadState().connectors).length > 0;
}
//# sourceMappingURL=state.js.map