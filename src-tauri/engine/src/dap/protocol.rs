use serde::{Deserialize, Serialize};
use serde_json::Value;

/// DAP uses the same `Content-Length` framing as LSP but a different JSON
/// envelope (`seq` / `type` / `command` / `event`). This module owns that
/// envelope and the protocol payload types used by the client.
pub const DAP_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageType {
    Request,
    Response,
    Event,
}

/// Base fields shared by every DAP message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseMessage {
    pub seq: i64,
    #[serde(rename = "type")]
    pub message_type: MessageType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request {
        #[serde(flatten)]
        base: BaseMessage,
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
    },
    Response {
        #[serde(flatten)]
        base: BaseMessage,
        request_seq: i64,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Event {
        #[serde(flatten)]
        base: BaseMessage,
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
    },
}

impl Message {
    pub fn request(seq: i64, command: impl Into<String>, arguments: Value) -> Self {
        Message::Request {
            base: BaseMessage {
                seq,
                message_type: MessageType::Request,
            },
            command: command.into(),
            arguments: Some(arguments),
        }
    }

    pub fn event(event: impl Into<String>, body: Value) -> Self {
        Message::Event {
            base: BaseMessage {
                seq: 0,
                message_type: MessageType::Event,
            },
            event: event.into(),
            body: Some(body),
        }
    }
}

// --- Client capability payloads -------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeRequestArguments {
    #[serde(rename = "clientID")]
    pub client_id: Option<String>,
    #[serde(rename = "clientName")]
    pub client_name: Option<String>,
    #[serde(rename = "adapterID")]
    pub adapter_id: String,
    pub path_format: Option<String>,
    pub lines_start_at_1: Option<bool>,
    pub columns_start_at_1: Option<bool>,
    pub supports_variable_type: Option<bool>,
    pub supports_variable_paging: Option<bool>,
    pub supports_run_in_terminal_request: Option<bool>,
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(rename = "supportsConfigurationDoneRequest")]
    pub supports_configuration_done_request: Option<bool>,
    #[serde(rename = "supportsSetVariable")]
    pub supports_set_variable: Option<bool>,
    #[serde(rename = "supportsEvaluateForHovers")]
    pub supports_evaluate_for_hovers: Option<bool>,
    #[serde(rename = "supportsTerminateRequest")]
    pub supports_terminate_request: Option<bool>,
    #[serde(rename = "supportsSteppingGranularity")]
    pub supports_stepping_granularity: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchRequestArguments {
    #[serde(rename = "noDebug")]
    pub no_debug: Option<bool>,
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachRequestArguments {
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub name: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "sourceReference")]
    pub source_reference: Option<i64>,
    pub presentation_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceBreakpoint {
    pub line: i64,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    pub log_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetBreakpointsArguments {
    pub source: Source,
    pub breakpoints: Vec<SourceBreakpoint>,
    #[serde(rename = "breakpointsUpdated")]
    pub breakpoints_updated: Option<bool>,
    #[serde(rename = "sourceModified")]
    pub source_modified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Breakpoint {
    pub id: Option<i64>,
    pub verified: bool,
    pub message: Option<String>,
    pub source: Option<Source>,
    pub line: Option<i64>,
    pub column: Option<i64>,
    pub end_line: Option<i64>,
    pub end_column: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetBreakpointsResponseBody {
    pub breakpoints: Vec<Breakpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadsResponseBody {
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub source: Option<Source>,
    pub line: i64,
    pub column: i64,
    pub end_line: Option<i64>,
    pub end_column: Option<i64>,
    pub can_restart: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackTraceArguments {
    pub thread_id: i64,
    pub start_frame: Option<i64>,
    pub levels: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackTraceResponseBody {
    pub stack_frames: Vec<StackFrame>,
    #[serde(rename = "totalFrames")]
    pub total_frames: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    pub name: String,
    #[serde(rename = "presentationHint")]
    pub presentation_hint: Option<String>,
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
    pub named_variables: Option<i64>,
    pub indexed_variables: Option<i64>,
    pub expensive: Option<bool>,
    pub source: Option<Source>,
    pub line: Option<i64>,
    pub column: Option<i64>,
    pub end_line: Option<i64>,
    pub end_column: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopesArguments {
    pub frame_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopesResponseBody {
    pub scopes: Vec<Scope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub variable_type: Option<String>,
    #[serde(rename = "variablesReference")]
    pub variables_reference: Option<i64>,
    pub named_variables: Option<i64>,
    pub indexed_variables: Option<i64>,
    pub evaluate_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariablesArguments {
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
    pub filter: Option<String>,
    pub start: Option<i64>,
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariablesResponseBody {
    pub variables: Vec<Variable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinueArguments {
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    pub single_thread: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinueResponseBody {
    #[serde(rename = "allThreadsContinued")]
    pub all_threads_continued: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextArguments {
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    #[serde(rename = "granularity")]
    pub granularity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepInArguments {
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    #[serde(rename = "granularity")]
    pub granularity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepOutArguments {
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    #[serde(rename = "granularity")]
    pub granularity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceArgs {
    pub source: Option<Source>,
    #[serde(rename = "sourceReference")]
    pub source_reference: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisconnectArguments {
    pub restart: Option<bool>,
    #[serde(rename = "terminateDebuggee")]
    pub terminate_debuggee: Option<bool>,
}

// --- Event bodies ---------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoppedEventBody {
    pub reason: String,
    #[serde(rename = "threadId")]
    pub thread_id: Option<i64>,
    #[serde(rename = "allThreadsStopped")]
    pub all_threads_stopped: Option<bool>,
    pub text: Option<String>,
    pub hit_breakpoint_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinuedEventBody {
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    #[serde(rename = "allThreadsContinued")]
    pub all_threads_continued: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEventBody {
    pub reason: String,
    #[serde(rename = "threadId")]
    pub thread_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputEventBody {
    pub category: Option<String>,
    pub output: String,
    pub source: Option<Source>,
    pub line: Option<i64>,
    pub column: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakpointEventBody {
    pub reason: String,
    pub breakpoint: Breakpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminatedEventBody {
    pub restart: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitedEventBody {
    pub exit_code: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEventBody {
    pub name: String,
    pub system_process_id: Option<i64>,
    pub is_local_process: Option<bool>,
    pub start_method: Option<String>,
}
