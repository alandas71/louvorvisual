package br.org.louvorvisual.projector

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteCommandMapperTest {
    @Test fun mapsRequiredRemoteButtons() {
        assertEquals(RemoteCommand.PREVIOUS, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(RemoteCommand.NEXT, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(RemoteCommand.CONFIRM, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals(RemoteCommand.BACK, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_BACK))
        assertEquals(RemoteCommand.UP, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(RemoteCommand.DOWN, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(RemoteCommand.MENU, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_MENU))
        assertEquals(RemoteCommand.PLAY_PAUSE, RemoteCommandMapper.fromKeyCode(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
    }

    @Test fun acceptsOnlyTheFirstDownEvent() {
        assertTrue(RemoteCommandMapper.isInitialPress(KeyEvent.ACTION_DOWN, 0))
        assertFalse(RemoteCommandMapper.isInitialPress(KeyEvent.ACTION_DOWN, 1))
        assertFalse(RemoteCommandMapper.isInitialPress(KeyEvent.ACTION_UP, 0))
    }
}
