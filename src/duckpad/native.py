"""Native execution with the same persistent cancellation as the SQL worker."""

import threading

import duckdb


class Cursor:
    def __init__(self, cursor):
        self.cursor = cursor
        self.lock = threading.Lock()
        self.canceled = False
        self.finished = None

    def __getattr__(self, name):
        return getattr(self.cursor, name)

    def execute(self, query, parameters=None):
        finished = threading.Event()
        with self.lock:
            if self.canceled:
                raise duckdb.InterruptException("Execution canceled")
            self.finished = finished
        try:
            self.cursor.execute(query, parameters or [])
            return self
        finally:
            finished.set()

    def interrupt(self):
        with self.lock:
            self.canceled = True
            finished = self.finished
        # DuckDB can reset an early interrupt while starting a statement. Keep
        # interrupting that operation until it exits; later statements are denied.
        if finished:
            while not finished.is_set():
                self.cursor.interrupt()
                finished.wait(0.01)
