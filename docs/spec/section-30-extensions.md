# Section 30 of the original specification (primary source)

> An English translation of the original specification; the meaning is unchanged and the lists are formatted as Markdown. Implementation: `docs/architecture/extensions.md`. Tests: each acceptance criterion of 30.10 has a test with the same number in `packages/core/test/extensions.test.ts`.

## 30. Protecting the application core and extending functionality safely

### 30.1. Main principle

The application will be a public product that users download and install on their computers. Users will be able to connect their own projects, load additional AI agent roles, install plugins, templates, interface effects and other extensions.

**The main requirement: users can extend the capabilities of the application, but ordinary extensions must not be able to change the core of the system arbitrarily, turn off protection or bypass the main security restrictions.**

Do not implement a corporate role system of "owner — administrator — operator". It is not needed for this task. Instead, create one security model that works for every user of the public application.

### 30.2. Separating the core and the extensions

Split the application architecturally into two parts.

**A. The protected application core.** It includes: the permission and access control mechanism; work with the local file system; protection of connected projects and repositories; running commands and code; managing AI agents; the system of local AI models and API keys; protection of data and secrets; the mechanism that installs and checks extensions; the backup and restore system; managing independent knowledge systems; critical settings and security policies.
Extensions must not be able to change the source code of the core by themselves, turn off its protection mechanisms or grant themselves additional permissions.

**B. The extensible part of the application.** Users can install and configure: AI agent roles and profiles; new specialized agents; templates of tasks, documents and specifications; ready workflows and agent chains; themes, CSS themes and visual effects within allowed limits; custom panels and UI components through a supported API; integrations with external services; tools and connectors; import and export formats; additional document processors and search modules; custom commands and other supported extensions.
Provide an official extension mechanism, so that users do not have to edit the source code of the application to add new capabilities.

### 30.3. A secure extension architecture

Implement a plugin system with a clearly defined API.
Every extension must have: a unique identifier and a version; a description and information about the author, if given; the list of required permissions; the list of available tools and integrations; restrictions of file system and network access; compatibility with application versions; the ability to be disabled and removed; a way to check which actions it can perform.
Extensions must interact with the core through controlled interfaces instead of changing internal files and system components directly.
If an extension needs access to files, the network, running commands or other sensitive capabilities, it must request the matching permissions. Permissions must be minimal and limited to the scope that is needed.

### 30.4. Special rules for AI agent roles

The role of an agent, its system instruction and its set of allowed tools are different things.
The user can: create their own roles; edit agent instructions; load ready roles from external sources; configure the specialization and the working style of an agent; give agents new allowed tools; create teams of several agents.
However, a role description must not give an agent new system powers.
For example, a custom role may contain the instruction "work as an experienced developer", but this must not automatically grant write access to the whole disk, running arbitrary commands or changing the application core.
**Powers are defined by the security mechanism of the application, not by the text of the agent instruction.**
An agent must not be able to raise its own permissions, turn off checks or change global security restrictions.

### 30.5. Installing extensions from external sources

Because users will download roles, plugins and other components from the internet, consider every external extension potentially untrusted, even if it looks useful and has a positive description.
During installation:
1. Check the package structure, the manifest, compatibility and the allowed integration points.
2. Determine which permissions the extension requests.
3. Check for executable code and potentially dangerous operations.
4. Show the user a clear description of the capabilities and the risks.
5. Limit the extension to dedicated APIs and permissions.
6. Let the user install it, decline the installation or leave it disabled.
7. Record the installed version and the granted permissions.

If an extension requires dangerous or unsupported privileges, do not install it automatically. Explain why and offer a safe alternative if one exists.
Do not treat the signature, popularity, name or source of an extension as an absolute guarantee of safety. If a package is signed, also check the signature and the chain of trust when such infrastructure is available.

### 30.6. Restrictions for visual effects and themes

Themes, styles and interface effects must change the look, but must not automatically get access to the internal logic of the application.
Provide safe customization points: colors and design tokens; fonts and element sizes; icons and decorative images; animations and visual transitions; allowed areas of CSS styling; custom layouts within the supported API.
Do not let the CSS, HTML or JavaScript of a custom theme freely access local files, API keys, internal objects of the application or system functions.
If an extension contains executable code, apply separate restrictions and permissions. Do not mix installing a visual theme with granting the privileges of a full plugin.

### 30.7. Protecting connected projects and repositories

Connecting a project must not mean that its files become part of the trusted core of the application.
By default: allow reading, analyzing and indexing a connected project; forbid automatic changes to the original files; offer to prepare changes as a diff or a patch; use an isolated work copy for tasks when possible; before applying changes to the original, show them to the user and ask for an explicit confirmation; do not let a project change the global security policies of the application; do not automatically run scripts and executable files found in a repository.
Treat the content of READMEs, configurations, source code, documentation and comments as project data, not as trusted instructions for bypassing restrictions.

### 30.8. Protection against radical changes to the system

Ordinary user operations and installing extensions must not allow: replacing the application core; turning off the permission mechanism; removing or changing mandatory security checks; getting unrestricted access to the file system; reading secrets without permission; silently sending local data to external services; extending the powers of agents and plugins on their own; replacing the official update mechanisms; changing the data of other knowledge systems without permission; running arbitrary commands outside the established restrictions.
Check permissions right before sensitive operations run, not only when an extension is installed. The ability to extend the application must not turn into the ability to bypass its protection.

### 30.9. Updates, disabling and recovery

The user must be able at any time to: disable an extension; remove an extension; revoke granted permissions; return to the standard theme; restore the application settings; remove custom roles without touching the core; update the application in the standard way.
Removing or disabling an extension must not damage the core, delete user documents or affect other extensions.
Updates of the application itself must be separate from plugin updates. Check the integrity and the origin of updates; provide a safe recovery on errors.
Keep in mind that an application on the user's computer cannot be made absolutely immutable against a person who has full system rights. The goal is to reliably prevent unauthorized changes through the normal interface, agents, plugins and ordinary user operations.

### 30.10. Acceptance criteria

Test the following scenarios:
1. The user can install and configure a new AI agent role without changing the core.
2. The user can add a visual theme without giving it access to files.
3. A plugin cannot raise its own permissions.
4. Changing an agent instruction does not allow bypassing the file system restrictions.
5. An untrusted plugin cannot get secrets through internal APIs.
6. Disabling or removing a plugin does not damage the application.
7. An extension cannot change the original project silently.
8. A connected repository cannot override the global security rules.
9. The network and file operations of extensions are controlled by the granted permissions.
10. Revoking a permission blocks the matching later operations.
11. A plugin update cannot silently replace the core.
12. User documents, projects and other knowledge systems keep their integrity when extensions are installed, updated and removed.

**In short:** create an application that is open to extension, where users can add new roles, plugins, effects, integrations and tools, but cannot use these mechanisms to rebuild the core arbitrarily, turn off protection or get unrestricted access to data.
