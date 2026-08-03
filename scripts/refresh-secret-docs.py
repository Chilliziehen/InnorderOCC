"""Bring the deployment chapters' secret inventories in line with compose.yml.

The merged stack adds the AI runtime database password and the cursor HMAC key
to the Compose secret set, so every enumeration and every scalar-count phrase in
Docs/Deployment has to name them.
"""
import io
import os
import re

DOCS = 'Docs/Deployment'
ANCHOR = 'POSTGRES_RUNTIME_PASSWORD_FILE'
ADDED = ['AI_DATABASE_PASSWORD_FILE', 'CURSOR_HMAC_KEY_FILE']
# File-name mapping used by the PowerShell ordered-hash inventories.
FILE_NAMES = {
    'AI_DATABASE_PASSWORD_FILE': 'postgres-ai-runtime-password',
    'CURSOR_HMAC_KEY_FILE': 'cursor-hmac-key',
}

# Each pattern captures the anchor plus the separator that follows it, so the
# inserted keys reuse the exact syntax of the surrounding list.
STYLES = [
    (re.compile(r"'" + ANCHOR + r"',"), lambda k: "'" + k + "',"),
    (re.compile(r'\b' + ANCHOR + r'\|'), lambda k: k + '|'),
    (re.compile(r'\b' + ANCHOR + r"='[a-z-]+';"), None),
    (re.compile(r'\b' + ANCHOR + r' '), lambda k: k + ' '),
]

COUNT_FIXES = [
    ('八个标量密钥', '十一个标量密钥'),
    ('八个互异标量密钥', '十一个互异标量密钥'),
    ('八个标量文件', '十一个标量文件'),
    ("throw '八个标量密钥值必须全部互异'", "throw '十一个标量密钥值必须全部互异'"),
    ('.Count -ne 8) { throw', '.Count -ne 11) { throw'),
    ('十个外部文件权限合格', '十三个外部文件权限合格'),
    ('`.env` 只有十路径', '`.env` 只有十三路径'),
]


def insert_keys(line):
    if ANCHOR not in line:
        return line
    if all(key in line for key in ADDED):
        return line

    ordered = re.search(r'\b' + ANCHOR + r"='([a-z-]+)';", line)
    if ordered:
        addition = ''.join(
            f" {key}='{FILE_NAMES[key]}';" for key in ADDED if key not in line
        )
        return line.replace(ordered.group(0), ordered.group(0) + addition, 1)

    for pattern, render in STYLES:
        if render is None:
            continue
        match = pattern.search(line)
        if not match:
            continue
        addition = ''.join(render(key) for key in ADDED if key not in line)
        return line.replace(match.group(0), match.group(0) + addition, 1)
    return line


changed = []
for name in sorted(os.listdir(DOCS)):
    if not name.endswith('.md'):
        continue
    path = os.path.join(DOCS, name)
    original = io.open(path, encoding='utf-8').read()
    lines = original.split('\n')
    for index, line in enumerate(lines):
        if ANCHOR in line and 'MINIO_APP_PASSWORD_FILE' in line:
            lines[index] = insert_keys(line)
    text = '\n'.join(lines)
    for old, new in COUNT_FIXES:
        text = text.replace(old, new)
    if text != original:
        io.open(path, 'w', encoding='utf-8', newline='').write(text)
        changed.append(name)

print('updated:', ', '.join(changed) if changed else 'none')
