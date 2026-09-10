import {
  Accordion, ActionIcon, Alert, Badge, Code, Group, Pagination, Skeleton, Stack, Table, Text, Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconBan, IconCheck, IconEye, IconHourglassEmpty, IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { commandDetailQuery } from '../queries';

function ResultGroup({
  status = 'pending', targets, result, itemKey, itemValue,
}) {
  const hostNames = targets.map((t) => t.name || t.hostname || t.mac).sort();
  const displayNames = hostNames.length > 10
    ? `${hostNames.slice(0, 10).join(', ')}, ... (+${hostNames.length - 10} more)`
    : hostNames.join(', ');

  return (
    <Accordion.Item key={itemKey} value={itemValue}>
      <Accordion.Control>
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            {status === 'pending'
              ? `${targets.length} host${targets.length > 1 ? 's' : ''} pending: ${displayNames}`
              : `${targets.length} host${targets.length > 1 ? 's' : ''}: ${displayNames}`}
          </Text>
          <Badge color={status === 'pending' ? 'yellow' : status === 'succeeded' ? 'green' : ['failed', 'timed_out'].includes(status) ? 'red' : 'gray'} size="sm">
            {status.replace('_', ' ')}
          </Badge>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Text size="xs" c="dimmed" mb="xs">
          Hosts: {hostNames.join(', ')}
        </Text>
        {result && (
          <Code block style={{ maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {result}
          </Code>
        )}
        {!result && (
          <Text size="sm" c="dimmed">Waiting for execution result...</Text>
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function CommandResults({ id }: { id: string }) {
  const [page, setPage] = React.useState(1);
  const query = useQuery({ ...commandDetailQuery(id, page), refetchInterval: 5000 });
  if (query.isPending) return <Skeleton h={100} />;
  if (query.isError) return <Alert color="red" title="Unable to load results">{query.error.message}</Alert>;
  const groups = new Map<string, { targets: any[]; status: string; text: string }>();
  for (const target of query.data.targetInfo) {
    const result = query.data.results[target.mac];
    const text = result ? [`status: ${result.status}`, `exitCode: ${result.exitCode ?? '-'}`,
      result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`].filter(Boolean).join('\n') : '';
    const key = text || 'pending';
    if (!groups.has(key)) groups.set(key, { targets: [], status: result?.status || 'pending', text });
    groups.get(key)!.targets.push(target);
  }
  const pages = Math.max(1, Math.ceil(query.data.total / query.data.pageSize));
  return <Stack>
    <Text size="sm">{query.data.total} target computers</Text>
    <Accordion>{[...groups.values()].map((group, index) => <ResultGroup key={index}
      itemKey={String(index)} itemValue={String(index)} targets={group.targets} status={group.status} result={group.text} />)}</Accordion>
    {pages > 1 && <Pagination value={query.data.page} total={pages} onChange={setPage} size="sm" />}
  </Stack>;
}

const CommandRow = React.memo(({ command }: { command: any }) => {
  const clipboard = useClipboard();
  const queryClient = useQueryClient();
  const remove = React.useCallback((operation = 'remove') => {
    modals.openConfirmModal({
      title: operation === 'cancel' ? 'Cancel waiting targets' : 'Remove command history',
      children: <Text size="sm">{operation === 'cancel' ? 'Waiting targets will be cancelled. Commands already dispatched will finish and remain in history.' : 'This removes the command and its execution results from history.'}</Text>,
      labels: { confirm: operation === 'cancel' ? 'Cancel waiting targets' : 'Remove', cancel: 'Back' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const response = await fetch('/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              operation,
              command: command._id,
            }),
          });
          if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
          const result = await response.json();
          if (result.error) throw new Error(result.error.message || 'Server rejected the request');
          await queryClient.invalidateQueries({ queryKey: ['commands'] });
          notifications.show({ title: 'Success', message: operation === 'cancel' ? 'Waiting targets cancelled' : 'Command removed', color: 'green' });
        } catch (error) {
          console.error(error);
          notifications.show({ title: 'Error', message: 'Failed to remove command', color: 'red' });
        }
      },
    });
  }, [command._id, queryClient]);
  const getStatusBadge = () => {
    const { status } = command;
    if (status.total === 0) {
      return <Badge color="gray">No Target</Badge>;
    }
    if (status.failed + status.timedOut > 0) return <Badge color="red" leftSection={<IconX size={14} />}>{status.failed} failed · {status.timedOut} timed out{status.pending ? ` · ${status.pending} pending` : ''}</Badge>;
    if (status.pending > 0) {
      return <Badge color="yellow" leftSection={<IconHourglassEmpty size={14} />}>{status.completed}/{status.total}</Badge>;
    }
    if (status.expired || status.cancelled) return <Badge color="gray">{status.expired} expired · {status.cancelled} cancelled</Badge>;
    return <Badge color="green" leftSection={<IconCheck size={14} />}>{status.completed}/{status.total}</Badge>;
  };

  return (
    <>
      <Table.Tr key={command._id}>
        <Table.Td style={{ maxWidth: 100 }}>
          <Tooltip label={command._id}>
            <Text size="sm" c="dimmed" truncate>
              {command._id.substring(0, 8)}
            </Text>
          </Tooltip>
        </Table.Td>
        <Table.Td style={{ maxWidth: 400 }}>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <button
              type="button"
              style={{
                margin: 0,
                padding: '4px 8px',
                border: 0,
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                textAlign: 'left',
                maxWidth: '100%',
                maxHeight: '200px',
                overflow: 'hidden',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                backgroundColor: 'var(--mantine-color-gray-0)',
                borderRadius: '4px',
                cursor: 'pointer',
                flex: 1,
              }}
              onClick={() => {
                clipboard.copy(command.command);
                notifications.show({ title: 'Success', message: 'Command copied to clipboard!', color: 'green' });
              }}
              aria-label="Copy command"
            >
              {command.command}
            </button>
          </Group>
        </Table.Td>
        <Table.Td style={{ minWidth: 260 }}>
          {getStatusBadge()}
        </Table.Td>
        <Table.Td>
          <Group gap="xs">
            <Tooltip label="View Results">
              <ActionIcon
                variant="subtle"
                color="blue"
                aria-label="View execution results"
                onClick={() => {
                  modals.open({
                    title: 'Execution Results', size: 'xl', children: <CommandResults id={command._id} />,
                  });
                }}
              >
                <IconEye size={16} />
              </ActionIcon>
            </Tooltip>
            {command.status.pending > command.status.running && (
              <Tooltip label="Cancel waiting targets"><ActionIcon color="orange" variant="subtle" aria-label="Cancel waiting targets" onClick={() => remove('cancel')}><IconBan size={16} /></ActionIcon></Tooltip>
            )}
            <Tooltip label="Remove">
              <ActionIcon variant="subtle" color="red" aria-label="Remove command" disabled={command.status.pending > 0} onClick={() => remove()}>
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    </>
  );
});

export function CommandHistoryTable({ commands }) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 100 }}>ID</Table.Th>
            <Table.Th>Command</Table.Th>
            <Table.Th style={{ width: 260 }}>Status</Table.Th>
            <Table.Th style={{ width: 100 }}>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{commands.map((command) => (
          <CommandRow key={command._id} command={command} />
        ))}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
