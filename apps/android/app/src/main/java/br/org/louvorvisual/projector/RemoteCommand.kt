package br.org.louvorvisual.projector

import android.view.KeyEvent

internal enum class RemoteCommand(val wireName: String) {
    UP("up"), DOWN("down"), PREVIOUS("left"), NEXT("right"), CONFIRM("ok"), BACK("back"), MENU("menu"), PLAY_PAUSE("playPause"),
}

/** A fronteira única entre as teclas Android e os comandos do bundle local. */
internal object RemoteCommandMapper {
    fun fromKeyCode(keyCode: Int): RemoteCommand? = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_UP -> RemoteCommand.UP
        KeyEvent.KEYCODE_DPAD_DOWN -> RemoteCommand.DOWN
        KeyEvent.KEYCODE_DPAD_LEFT -> RemoteCommand.PREVIOUS
        KeyEvent.KEYCODE_DPAD_RIGHT -> RemoteCommand.NEXT
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_ENTER,
        KeyEvent.KEYCODE_NUMPAD_ENTER -> RemoteCommand.CONFIRM
        KeyEvent.KEYCODE_MENU -> RemoteCommand.MENU
        KeyEvent.KEYCODE_BACK -> RemoteCommand.BACK
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE -> RemoteCommand.PLAY_PAUSE
        else -> null
    }

    fun isInitialPress(event: KeyEvent): Boolean = isInitialPress(event.action, event.repeatCount)

    fun isInitialPress(action: Int, repeatCount: Int): Boolean =
        action == KeyEvent.ACTION_DOWN && repeatCount == 0
}
