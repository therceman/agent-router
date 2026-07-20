# Workflow Profiles

Agent Router ships four explicit profiles:

| Profile | Planning brain | Implementation/research | Review sequence |
|---|---|---|---|
| `development` | external ChatGPT/owner | Luna-xhigh default implementation with Terra-high escalation | external reviewer |
| `secure-development-external-brain` | external ChatGPT/owner | Luna-xhigh default implementation with Terra-high escalation | Terra verifier → Sol security reviewer |
| `secure-development-local-brain` | local Sol architect | Luna-xhigh default implementation with Terra-high escalation | Terra verifier → Sol security reviewer |
| `security-research` | owner/research plan | Sol researcher with Terra scout | Terra verifier → Sol security reviewer |

Profiles define default roles, plan requirement, review sequence, and review-pack purpose. They do not change the storage architecture or create workflow files in a work repository.

A future profile must use a distinct ID and may not silently change another profile’s semantics.
