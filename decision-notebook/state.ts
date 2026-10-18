// Editor/test compatibility shim only. Runtime helpers are inline so same-process updates cannot use stale imports.
export {
    NotebookDoc,
    NotebookError,
    emptyNotebook,
    validateContent,
    stateOf,
    propose,
    expectRevision,
    approve,
    editProposal,
    withdraw,
    findDecisions,
    markdown,
} from "../decision-notebook.ts";
export type { Notebook, Decision, DecisionContent } from "../decision-notebook.ts";
