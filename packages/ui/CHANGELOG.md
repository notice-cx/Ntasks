# Changelog

## [0.5.1](https://github.com/notice-cx/Ntasks/compare/ui-v0.5.0...ui-v0.5.1) (2026-11-14)


### Bug Fixes

* **ui:** make tasks waiting for you easy to mark done ([#243](https://github.com/notice-cx/Ntasks/issues/243)) ([5ff8aaa](https://github.com/notice-cx/Ntasks/commit/5ff8aaa38298608af149f16706d9bb04ccf4b02a))

## [0.5.0](https://github.com/notice-cx/Ntasks/compare/ui-v0.4.0...ui-v0.5.0) (2026-11-13)


### Features

* add a Next queue for agent work ([#229](https://github.com/notice-cx/Ntasks/issues/229)) ([b0dfb29](https://github.com/notice-cx/Ntasks/commit/b0dfb29582a6ef64237035507b641b49db6872e6))
* add and remove links between tasks over HTTP and on the task page ([#178](https://github.com/notice-cx/Ntasks/issues/178)) ([52aae66](https://github.com/notice-cx/Ntasks/commit/52aae66de40cb75445dd94e99e790d16d0f7c2c0))
* **api:** an approval turns on its pull request's auto-merge and posts each answer on it ([#193](https://github.com/notice-cx/Ntasks/issues/193)) ([147f482](https://github.com/notice-cx/Ntasks/commit/147f482c25400f529935ba3e071e5bb1fb8aabf7))
* **api:** list tasks by the helper or session that changed them, and carry test runs ([#182](https://github.com/notice-cx/Ntasks/issues/182)) ([de4cae1](https://github.com/notice-cx/Ntasks/commit/de4cae1106f48e9499d93ef704c270ba5c6ff69a))
* **api:** move pushed work to merged, and its deploy to live ([#192](https://github.com/notice-cx/Ntasks/issues/192)) ([6a7cd0e](https://github.com/notice-cx/Ntasks/commit/6a7cd0e7f961664e0ad85e42ed57cb6c6e1cc072))
* **api:** name the D1 migrations a deploy skipped instead of failing blindly ([#168](https://github.com/notice-cx/Ntasks/issues/168)) ([8217a2c](https://github.com/notice-cx/Ntasks/commit/8217a2cd2d30f124ec06ab50c310996ac15c2f35))
* let a person mark an approval as done by them, not approved ([#187](https://github.com/notice-cx/Ntasks/issues/187)) ([1ef208e](https://github.com/notice-cx/Ntasks/commit/1ef208e938745cf83ae75d12ea1e941d0bdb6ccd))
* let a repository's merges count as live when it has no deploy ([#208](https://github.com/notice-cx/Ntasks/issues/208)) ([e45d100](https://github.com/notice-cx/Ntasks/commit/e45d100209efb5b2e1425f43d0d8cd803649ea3f))
* manage projects and their site icons from a Settings page in tabs ([#153](https://github.com/notice-cx/Ntasks/issues/153)) ([4d4da75](https://github.com/notice-cx/Ntasks/commit/4d4da758b34bd0e5abd8406b84e3181ac64ad817))
* mark a closed task live by hand, for a release no signal reports ([#210](https://github.com/notice-cx/Ntasks/issues/210)) ([696e084](https://github.com/notice-cx/Ntasks/commit/696e0844ed630669d10ce4b2b24dbc53ea0cfe26))
* move tasks to another epic or project, keeping their history and links ([#186](https://github.com/notice-cx/Ntasks/issues/186)) ([d90b91f](https://github.com/notice-cx/Ntasks/commit/d90b91f10ee155067a05b477782d84cd31193ff1))
* name the dropped tasks an open task relies on ([#177](https://github.com/notice-cx/Ntasks/issues/177)) ([089bf82](https://github.com/notice-cx/Ntasks/commit/089bf82659661a724af4ee61e73658600a2f7dc1))
* show a short summary for detailed task comments ([#236](https://github.com/notice-cx/Ntasks/issues/236)) ([7388d51](https://github.com/notice-cx/Ntasks/commit/7388d51bd7c736c56f84728d4fb2ba3d77640677))
* **ui:** give projects their own overview ([#233](https://github.com/notice-cx/Ntasks/issues/233)) ([b755033](https://github.com/notice-cx/Ntasks/commit/b7550330b42139f0a882b02d5d1b27f4989bec0f))
* **ui:** let a deployment admin create another workspace from the workspace menu ([#160](https://github.com/notice-cx/Ntasks/issues/160)) ([be45260](https://github.com/notice-cx/Ntasks/commit/be45260a9df94f2e47a3a237f1d22a4bccb2f190))
* **ui:** list only the custom fields a task holds, with Add field for the rest ([#172](https://github.com/notice-cx/Ntasks/issues/172)) ([c04f7e8](https://github.com/notice-cx/Ntasks/commit/c04f7e8e4e284a140e6a9ed920bf005bd22daf47))
* **ui:** M, A, P and Z claim, assign, prioritise and park the task in view ([#183](https://github.com/notice-cx/Ntasks/issues/183)) ([9e73b14](https://github.com/notice-cx/Ntasks/commit/9e73b14506f4cdcd24b5aa501a9202e0a20de500))
* **ui:** make and revoke service credentials on a Services tab in Settings ([#170](https://github.com/notice-cx/Ntasks/issues/170)) ([8217778](https://github.com/notice-cx/Ntasks/commit/82177788aa7ac9e1f914a727f7190c06ab6160f0))
* **ui:** show delivery in the task breadcrumb bar ([#240](https://github.com/notice-cx/Ntasks/issues/240)) ([05d9948](https://github.com/notice-cx/Ntasks/commit/05d99488dbf674f7bdd2165a796a0f6b9a7b1b64))
* **ui:** show who filed a task, with their avatar, on its page ([#159](https://github.com/notice-cx/Ntasks/issues/159)) ([ca605b2](https://github.com/notice-cx/Ntasks/commit/ca605b254de25c2d274694831a2421a84ae47968))
* **ui:** tint task and epic headers by status ([#238](https://github.com/notice-cx/Ntasks/issues/238)) ([1aa9901](https://github.com/notice-cx/Ntasks/commit/1aa9901c6fb0055e0b72d19b36088bdfd77f4772))
* **ui:** tint task rows and Live cards by status ([#241](https://github.com/notice-cx/Ntasks/issues/241)) ([2bd70eb](https://github.com/notice-cx/Ntasks/commit/2bd70eb80f529a2237354da031dd482301d92545))
* **web:** join Built and Merged into one Waiting to ship column ([#191](https://github.com/notice-cx/Ntasks/issues/191)) ([81345ae](https://github.com/notice-cx/Ntasks/commit/81345aeeb7fe2208cffd684e0fc34751d577219c))
* **web:** lead a Live card with its project's icon, and show its holder as an icon ([#196](https://github.com/notice-cx/Ntasks/issues/196)) ([e86fb15](https://github.com/notice-cx/Ntasks/commit/e86fb1534c2a6c136cb8950e63909d0a9d8ee7d0))
* **web:** let a person decline an approval ([#219](https://github.com/notice-cx/Ntasks/issues/219)) ([a73db1b](https://github.com/notice-cx/Ntasks/commit/a73db1b6a7f52faa2ae0d1d724b201af94310c9f))
* **web:** let a person hide the sidebar to give pages the full width ([#209](https://github.com/notice-cx/Ntasks/issues/209)) ([40d3fa9](https://github.com/notice-cx/Ntasks/commit/40d3fa9e374f1d322b5ba7dd476ed55e6dc3b422))
* **web:** let people finish requests without ticking every step ([#226](https://github.com/notice-cx/Ntasks/issues/226)) ([b34071e](https://github.com/notice-cx/Ntasks/commit/b34071e3c617b31b632e67a8d24cde29260b3604))
* **web:** open the Live page on an animated board of delivery stages ([#188](https://github.com/notice-cx/Ntasks/issues/188)) ([cf80025](https://github.com/notice-cx/Ntasks/commit/cf800255bc10adfa36782386bdee15925ef6b31a))
* **web:** show a Live column's hidden cards, and pick 24 hours or 7 days ([#202](https://github.com/notice-cx/Ntasks/issues/202)) ([70c1a26](https://github.com/notice-cx/Ntasks/commit/70c1a26af20e74bb0bbade8a571e7cbe034d6695))
* **web:** show open pull requests in Waiting to ship ([#228](https://github.com/notice-cx/Ntasks/issues/228)) ([776e95d](https://github.com/notice-cx/Ntasks/commit/776e95dc7aa10f05d93d73d9669740639ef2ef90))
* **web:** show the dropped tasks a task relies on, on its row and page ([#201](https://github.com/notice-cx/Ntasks/issues/201)) ([912cb0b](https://github.com/notice-cx/Ntasks/commit/912cb0b7ce52a8c1a47c5938da6994a7d9942d56))
* **web:** show who changed a card and how on the Live board ([#189](https://github.com/notice-cx/Ntasks/issues/189)) ([08a66a6](https://github.com/notice-cx/Ntasks/commit/08a66a60365160035eebefa49cb6fdf5e358d845))


### Bug Fixes

* **api:** let the GitHub check move pushed tasks to live ([#199](https://github.com/notice-cx/Ntasks/issues/199)) ([4b02bb3](https://github.com/notice-cx/Ntasks/commit/4b02bb32ee821d6954fe7f1ed27278b334e3bb13))
* **api:** record a person named like an agent as person:&lt;name&gt; ([#194](https://github.com/notice-cx/Ntasks/issues/194)) ([731c5db](https://github.com/notice-cx/Ntasks/commit/731c5dbf845ebd868f87e24ef8d26293fa47ea77))
* show a project's dark-mode icon when Ntasks is dark ([#190](https://github.com/notice-cx/Ntasks/issues/190)) ([fa8cc3f](https://github.com/notice-cx/Ntasks/commit/fa8cc3f3340579452417d4d22c400cfd5358c65e))
* **ui:** fit every page on a phone screen with no sideways scroll ([#155](https://github.com/notice-cx/Ntasks/issues/155)) ([c500c82](https://github.com/notice-cx/Ntasks/commit/c500c820df2db63f06b09aa32eb4364966702a51))
* **ui:** give project pages top-level URLs ([#235](https://github.com/notice-cx/Ntasks/issues/235)) ([e86a47e](https://github.com/notice-cx/Ntasks/commit/e86a47eb241b6577115a156cf09a5c409b795b4c))
* **ui:** leave the main landmark to the host page in sheet mode ([#150](https://github.com/notice-cx/Ntasks/issues/150)) ([74664b4](https://github.com/notice-cx/Ntasks/commit/74664b4130008e20de2460629f9c2c18fbf41a5f))
* **ui:** remove closed sibling tasks from task pages ([#234](https://github.com/notice-cx/Ntasks/issues/234)) ([d37c20a](https://github.com/notice-cx/Ntasks/commit/d37c20a2dcc22028eb36689324147a7368e65e0b))
* **ui:** tint the breadcrumb bar and simplify task details ([#239](https://github.com/notice-cx/Ntasks/issues/239)) ([3491107](https://github.com/notice-cx/Ntasks/commit/3491107da0c79925aca7559616aa629b26673224))
* **web:** show sign-in when an embedded host has no token ([#211](https://github.com/notice-cx/Ntasks/issues/211)) ([8b6c95a](https://github.com/notice-cx/Ntasks/commit/8b6c95aae456550a12ed1326e583076300b86e06))


### Performance Improvements

* keep the web app's board in memory when its tasks carry many long links ([#167](https://github.com/notice-cx/Ntasks/issues/167)) ([0e71dae](https://github.com/notice-cx/Ntasks/commit/0e71daec45bcf48c47deffb29489a3c23135e67d))
* **ui:** draw a re-sorted board's first screen within 50 ms at 4x ([#204](https://github.com/notice-cx/Ntasks/issues/204)) ([075dce4](https://github.com/notice-cx/Ntasks/commit/075dce4eea78e96cc6c3dab3fae77c3ebcf97e8a))
* **ui:** redraw the board faster when its view or sort changes ([#180](https://github.com/notice-cx/Ntasks/issues/180)) ([dd255d0](https://github.com/notice-cx/Ntasks/commit/dd255d0d13b7586b04d6a71b4e5ebd9abeaeaf9c))

## [0.4.0](https://github.com/notice-cx/Ntasks/compare/ui-v0.3.0...ui-v0.4.0) (2026-11-10)


### Features

* show each agent under one name and each model by its name ([afad0eb](https://github.com/notice-cx/Ntasks/commit/afad0eb2b7b963a7de5d10cf31ce8d9e57a1ce2c))
* **ui:** let a host keep the sidebar behind its Sidebar button ([a4fbe1b](https://github.com/notice-cx/Ntasks/commit/a4fbe1b2a4b73f1dd930d729883e3242a2fe57ca))
* **ui:** let a host keep the sidebar behind its Sidebar button ([7204792](https://github.com/notice-cx/Ntasks/commit/720479287d118ab52c59ee284773156c6b9fd3aa))

## [0.3.0](https://github.com/notice-cx/Ntasks/compare/ui-v0.2.0...ui-v0.3.0) (2026-11-10)


### Features

* a Time zone setting in Settings, saved with the account (one new database column) ([664c9fe](https://github.com/notice-cx/Ntasks/commit/664c9fe06767efeb2e19bec107df3fcd39951b5c))
* a Time zone setting in Settings, saved with the person's account ([25a4e6b](https://github.com/notice-cx/Ntasks/commit/25a4e6bc1c3681169b1dc86a96456c8cfa752466))
* add the Productivity page, a feed of each day's wins ([ae72a25](https://github.com/notice-cx/Ntasks/commit/ae72a255a2706c88056ab63fb8f82e9efef7683a))
* **api:** list tasks in progress as active, quiet or stalled ([33cd751](https://github.com/notice-cx/Ntasks/commit/33cd7518b9f0037ad3ba4bfaf8adf3e263293894))
* **api:** list tasks in progress as active, quiet or stalled ([2e41345](https://github.com/notice-cx/Ntasks/commit/2e41345208dbaba6ff624e804ceda7911f0dd4da))
* **api:** say which files work touches and which PR merges first ([337bc58](https://github.com/notice-cx/Ntasks/commit/337bc5883df30bf04012acaa1ea3339d86877cad))
* show a burn-down of open tasks on the Productivity page ([721d6bf](https://github.com/notice-cx/Ntasks/commit/721d6bfc53461571668cbb357b01bd89840ad535))
* **ui:** draw a burn-down of open tasks on the Productivity page ([837413e](https://github.com/notice-cx/Ntasks/commit/837413e8f9cd583e0ac15481e2180c6f37755d6a))


### Bug Fixes

* cut the Productivity page's days at midnight in the viewer's time zone ([1940fbd](https://github.com/notice-cx/Ntasks/commit/1940fbd719365546a7cb2e8c839590d08bb16a3c))
* cut the Productivity page's days at midnight in the viewer's time zone ([1cc51c6](https://github.com/notice-cx/Ntasks/commit/1cc51c628249e0e9aa2aa8e2b8d9b5a0748b8804))
* **ui:** order an epic's closed tasks of the same close time as the Worker does ([ee47dd0](https://github.com/notice-cx/Ntasks/commit/ee47dd09defcb3f46e4596db4e06c8c6bdd0f634))

## [0.2.0](https://github.com/notice-cx/Ntasks/compare/ui-v0.1.0...ui-v0.2.0) (2026-11-10)


### Features

* **api:** connect GitHub with one button through a GitHub App ([778ded7](https://github.com/notice-cx/Ntasks/commit/778ded75fd18a06f40ef45b12d926f8bb4dc329f))
* **api:** connect GitHub with one button through a GitHub App (waits for your approval: three new tables) ([8f835a1](https://github.com/notice-cx/Ntasks/commit/8f835a166e3a1596898102617bf8b428b2ea0761))
* **api:** move tasks to merged and live from a signed GitHub webhook ([2e8c1cf](https://github.com/notice-cx/Ntasks/commit/2e8c1cf241efa9ba525b29dc4ac30da54e846ed8))
* **api:** move tasks to merged and live from a signed GitHub webhook (waits for your approval: one new table) ([c5e3dee](https://github.com/notice-cx/Ntasks/commit/c5e3dee1a22794bb2122eba7b13e88acdfb95d8d))
* **api:** show a task its epic's pinned facts and closed tasks ([c937e5c](https://github.com/notice-cx/Ntasks/commit/c937e5c3743c42f972ea11be3846ce08fb8bfcf4))
* **api:** show a task its epic's pinned facts and closed tasks ([96c30ea](https://github.com/notice-cx/Ntasks/commit/96c30ea82fabf4a3f0629e79552f293ef2757896))
* show stalled tasks and let a person free one ([70103c4](https://github.com/notice-cx/Ntasks/commit/70103c41a7e1f34bccbe1b8bcbd750609b4b4709))
* sort task pages and list_tasks by priority, dates or title ([3addd27](https://github.com/notice-cx/Ntasks/commit/3addd270654833f94a74d67c725438f7834ae221))
* sort task pages and list_tasks by priority, dates or title ([209334d](https://github.com/notice-cx/Ntasks/commit/209334d0cda99f055c205748b3aa48b71f9f017d))
* **ui:** add the Epics tab and show each task's epic on Live ([9cbb617](https://github.com/notice-cx/Ntasks/commit/9cbb617c4a508406b4ff9a313bd5db720e90d610))
* **ui:** add the Epics tab and show each task's epic on Live ([b2f82af](https://github.com/notice-cx/Ntasks/commit/b2f82afa9bc234adaeb4952419e9707dbe7e8d1f))
* **ui:** close a task as done on the person's own call ([404c766](https://github.com/notice-cx/Ntasks/commit/404c766582a4a359120f78297544227a42101409))
* **ui:** give each page a browser title that leads with what it shows ([779561e](https://github.com/notice-cx/Ntasks/commit/779561ee97b5228a404f2fa1f75ac019cce74150))
* **ui:** give each page a browser title that leads with what it shows ([21fe871](https://github.com/notice-cx/Ntasks/commit/21fe8719fe90b7a99e202b18ef2fadb954ab528f))
* **ui:** link every web address in a task's title, text, code and steps ([2301b81](https://github.com/notice-cx/Ntasks/commit/2301b8196e71817ce0344c49104cd8b2ebcfbf5b))
* **ui:** link every web address in a task's title, text, code and steps ([d879c48](https://github.com/notice-cx/Ntasks/commit/d879c4889d587ebd8035c44beb2fea6a8622f136))
* **ui:** show a task's priority as a P0 to P4 tag with a tooltip ([3de5b23](https://github.com/notice-cx/Ntasks/commit/3de5b2308738941b322d18d08f1a773bb9086004))
* **ui:** show a task's priority as a P0 to P4 tag with a tooltip ([75df0e6](https://github.com/notice-cx/Ntasks/commit/75df0e6e404998ed53d8c336e66dd5c4ac39b9cb))
* **ui:** show how long waiting work has waited, from its creation ([e46f6f9](https://github.com/notice-cx/Ntasks/commit/e46f6f92be07c0e4dd8993242aaeea02471970b9))
* **ui:** show how long waiting work has waited, from its creation ([1f50738](https://github.com/notice-cx/Ntasks/commit/1f50738f6fda0a450ecd955836e9c916ad6bf07d))
* **ui:** show where a stalled task stopped and free it ([3138750](https://github.com/notice-cx/Ntasks/commit/3138750b4d330e1fbecea23417062e4e70356ce5))


### Bug Fixes

* answer review of the parent context ([8ab555d](https://github.com/notice-cx/Ntasks/commit/8ab555d39058892367ec26614699781da86e07f4))
* **api:** fit a freed task's comment however long its work details ([3935589](https://github.com/notice-cx/Ntasks/commit/39355897425e7d5a808eaa3335cb08f8cc368e48))
* **api:** free only the claim the person's page showed ([79984a3](https://github.com/notice-cx/Ntasks/commit/79984a31fce5c02bbdafc1a4b108f04662162f69))
* **api:** keep deploy detection whole when a delivery's record fails ([3c24543](https://github.com/notice-cx/Ntasks/commit/3c2454350e2de6b4451d8d463320ef7277c5c2d9))
* **api:** keep work that ships no code out of Waiting for merge ([71d0c2e](https://github.com/notice-cx/Ntasks/commit/71d0c2ec0cc266fe92877a299fe5de6c6deea84c))
* **api:** keep work that ships no code out of Waiting for merge ([85ad7c2](https://github.com/notice-cx/Ntasks/commit/85ad7c2125eb2aa9e5ba1d7ef066c03fc7e86a43))
* **ui:** keep Done, my call's criteria as its form showed them ([eab9ec9](https://github.com/notice-cx/Ntasks/commit/eab9ec9b4022da98c50e27ea0c4eca05773e9e68))
* **ui:** keep Done, my call's criteria as its form showed them ([290ba07](https://github.com/notice-cx/Ntasks/commit/290ba077c0e24dfd84e550f96ba58ef933784165))
* **ui:** name the week's first day as the server does, and read the whole project for Epics ([54d5134](https://github.com/notice-cx/Ntasks/commit/54d5134daa2c3b1264098b0179eb3bce4b2f7152))
* **ui:** no Created tip without a creation time, and test the deploy rows' age ([78fa4c3](https://github.com/notice-cx/Ntasks/commit/78fa4c33f6fb76f6ee3fe8d6b049139ab8040104))
* **ui:** offer Set up by hand beside a connected GitHub App ([42e377a](https://github.com/notice-cx/Ntasks/commit/42e377a9ec03fe0695826ebe7a1929f318bd86a2))
* write one freed-task comment for the Worker and the web app's fixture ([932aab8](https://github.com/notice-cx/Ntasks/commit/932aab88ba9ad90e406f0bf13f28d405bef7d4cb))
